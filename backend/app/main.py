from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .config import ALLOWED_ORIGIN_REGEX, ALLOWED_ORIGINS
from .db import init_db

logging.basicConfig(level=logging.INFO)
logging.getLogger("app").setLevel(logging.INFO)

app = FastAPI(title="VisionLink PoC API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
