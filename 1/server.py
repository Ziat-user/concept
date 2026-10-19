#!/usr/bin/env python3
"""色探しゲーム プロトタイプ用ローカルサーバー。

標準ライブラリのみで動作する。役割は次の 3 つ。

1. web/ 以下のゲーム本体を配信する。
2. assets/images/ と assets/videos/ に置かれた素材を /assets/... として配信する。
   動画のシークには HTTP Range リクエストが必要なため、単一 Range に対応する。
3. /api/assets で素材一覧を JSON で返す（マニフェストの手書きは不要）。

ブラウザは file:// で開いたローカル画像から getImageData でピクセルを読めない
（キャンバスが汚染される）ため、このサーバー経由で同一オリジンとして配信する。
"""

from __future__ import annotations

import argparse
import email.utils
import json
import os
import posixpath
import re
import shutil
import sys
import threading
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import BinaryIO

ROOT_DIR = Path(__file__).resolve().parent
WEB_DIR = ROOT_DIR / "web"
ASSETS_DIR = ROOT_DIR / "assets"
IMAGES_DIR = ASSETS_DIR / "images"
VIDEOS_DIR = ASSETS_DIR / "videos"

IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".m4v", ".webm", ".ogv"})

# Windows ではレジストリの設定次第で .js が text/plain と判定され、
# ES Modules の読み込みが失敗することがあるため明示的に固定する。
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
}

COPY_CHUNK_SIZE = 64 * 1024
RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")


def list_assets(base_dir: Path, extensions: frozenset[str]) -> list[dict[str, str]]:
    """base_dir 以下（サブフォルダを含む）の素材を名前順で列挙する。隠しファイルは除外する。"""
    if not base_dir.is_dir():
        return []
    items: list[dict[str, str]] = []
    for path in sorted(base_dir.rglob("*"), key=lambda p: p.as_posix().lower()):
        if not path.is_file() or path.suffix.lower() not in extensions:
            continue
        relative_to_base = path.relative_to(base_dir)
        if any(part.startswith(".") for part in relative_to_base.parts):
            continue
        relative_to_assets = path.relative_to(ASSETS_DIR).as_posix()
        items.append({
            "name": relative_to_base.as_posix(),
            "url": "/assets/" + urllib.parse.quote(relative_to_assets),
        })
    return items


class GameRequestHandler(SimpleHTTPRequestHandler):
    """静的配信 + 素材一覧 API + 単一 Range 対応のハンドラ。"""

    server_version = "ColorSearchGame/1.0"

    def __init__(self, *args, **kwargs) -> None:
        self._byte_range: tuple[int, int] | None = None
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    # ---- ルーティング -------------------------------------------------

    def do_GET(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/assets":
            self._send_asset_list()
            return
        try:
            file = self.send_head()
            if file is None:
                return
            try:
                if self._byte_range is None:
                    shutil.copyfileobj(file, self.wfile, COPY_CHUNK_SIZE)
                else:
                    self._copy_range(file, *self._byte_range)
            finally:
                file.close()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # 動画のシーク中にブラウザが接続を打ち切るのは正常な挙動。
            pass

    def do_HEAD(self) -> None:
        if urllib.parse.urlsplit(self.path).path == "/api/assets":
            self._send_asset_list(head_only=True)
            return
        file = self.send_head()
        if file is not None:
            file.close()

    # ---- パス解決 -----------------------------------------------------

    def translate_path(self, path: str) -> str:
        """/assets/... は assets/ に、それ以外は web/ に割り当てる。ルート外への脱出は拒否する。"""
        url_path = urllib.parse.unquote(urllib.parse.urlsplit(path).path, errors="surrogatepass")
        if url_path == "/assets" or url_path.startswith("/assets/"):
            base_dir = ASSETS_DIR
            relative = url_path[len("/assets"):]
        else:
            base_dir = WEB_DIR
            relative = url_path

        parts = [part for part in posixpath.normpath(relative).split("/") if part not in ("", ".", "..")]
        base_resolved = base_dir.resolve()
        candidate = base_resolved.joinpath(*parts).resolve()
        if candidate != base_resolved and not candidate.is_relative_to(base_resolved):
            # 存在しないパスを返して 404 にする。
            return str(base_resolved / "\0forbidden")
        result = str(candidate)
        if url_path.endswith("/"):
            result += os.sep
        return result

    def list_directory(self, path: str | os.PathLike[str]) -> None:
        """ディレクトリ一覧は公開しない。"""
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    def guess_type(self, path: str | os.PathLike[str]) -> str:
        suffix = Path(path).suffix.lower()
        return CONTENT_TYPES.get(suffix, "application/octet-stream")

    # ---- Range 対応 ---------------------------------------------------

    def send_head(self) -> BinaryIO | None:
        self._byte_range = None
        path = self.translate_path(self.path)
        range_header = self.headers.get("Range")
        if os.path.isdir(path) or not range_header:
            return super().send_head()

        match = RANGE_PATTERN.match(range_header.strip())
        if match is None:
            # 複数 Range など未対応の形式は、仕様上許される通り全体を返す。
            return super().send_head()

        try:
            file = open(path, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        stat = os.fstat(file.fileno())
        size = stat.st_size
        try:
            start_text, end_text = match.groups()
            if start_text == "" and end_text == "":
                raise ValueError("empty range")
            if start_text == "":
                suffix_length = int(end_text)
                if suffix_length == 0:
                    raise ValueError("zero suffix")
                start = max(size - suffix_length, 0)
                end = size - 1
            else:
                start = int(start_text)
                end = int(end_text) if end_text else size - 1
                end = min(end, size - 1)
            if size == 0 or start > end or start >= size:
                raise ValueError("unsatisfiable range")
        except ValueError:
            file.close()
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        file.seek(start)
        self.send_response(HTTPStatus.PARTIAL_CONTENT)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Last-Modified", email.utils.formatdate(stat.st_mtime, usegmt=True))
        self.end_headers()
        self._byte_range = (start, end)
        return file

    def _copy_range(self, file: BinaryIO, start: int, end: int) -> None:
        remaining = end - start + 1
        while remaining > 0:
            chunk = file.read(min(COPY_CHUNK_SIZE, remaining))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def end_headers(self) -> None:
        self.send_header("Accept-Ranges", "bytes")
        # 素材を差し替えたときにブラウザキャッシュで古い内容が使われないようにする。
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---- API ----------------------------------------------------------

    def _send_asset_list(self, head_only: bool = False) -> None:
        payload = {
            "images": list_assets(IMAGES_DIR, IMAGE_EXTENSIONS),
            "videos": list_assets(VIDEOS_DIR, VIDEO_EXTENSIONS),
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="色探しゲーム プロトタイプ用ローカルサーバー")
    parser.add_argument("--host", default="127.0.0.1",
                        help="待ち受けアドレス（既定: 127.0.0.1。LAN に公開する場合のみ 0.0.0.0 を指定）")
    parser.add_argument("--port", type=int, default=8000, help="待ち受けポート（既定: 8000）")
    parser.add_argument("--no-browser", action="store_true", help="起動時にブラウザを開かない")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not WEB_DIR.is_dir():
        print(f"エラー: web フォルダが見つかりません: {WEB_DIR}", file=sys.stderr)
        return 1
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), GameRequestHandler)
    except OSError as error:
        print(f"エラー: {args.host}:{args.port} で待ち受けできません（{error}）。--port で別のポートを指定してください。",
              file=sys.stderr)
        return 1
    httpd.daemon_threads = True

    browse_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = f"http://{browse_host}:{args.port}/"
    images = len(list_assets(IMAGES_DIR, IMAGE_EXTENSIONS))
    videos = len(list_assets(VIDEOS_DIR, VIDEO_EXTENSIONS))
    print(f"色探しゲーム: {url}")
    print(f"  画像: {images} 件 ({IMAGES_DIR})")
    print(f"  動画: {videos} 件 ({VIDEOS_DIR})")
    print("  終了するには Ctrl+C を押してください。")

    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
