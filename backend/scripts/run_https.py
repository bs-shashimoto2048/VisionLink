from __future__ import annotations

import uvicorn

from app.main import app
from scripts.setup_https import CERT_PATH, KEY_PATH, build_certificate


def main() -> None:
    build_certificate()
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        ssl_keyfile=str(KEY_PATH),
        ssl_certfile=str(CERT_PATH),
    )


if __name__ == "__main__":
    main()

