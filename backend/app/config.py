import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
DB_PATH = BASE_DIR / "data" / "visionlink.db"
API_PREFIX = "/api"
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://localhost:5173",
    "https://127.0.0.1:5173",
]
ALLOWED_ORIGIN_REGEX = r"^https?://[^/]+:5173$"
CHECK_DATA_ROOT = Path(os.environ.get("CHECK_DATA_ROOT", BASE_DIR.parent / "check_data" / "product")).resolve()
