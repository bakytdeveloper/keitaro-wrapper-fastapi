import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT.parent / ".env")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/keitaro_wrapper.db")
if DATABASE_URL.startswith("sqlite:///./"):
    Path(DATABASE_URL.replace("sqlite:///./", "")).parent.mkdir(parents=True, exist_ok=True)
KEITARO_BASE_URL = os.getenv("KEITARO_BASE_URL", "").strip().rstrip("/")
if KEITARO_BASE_URL.endswith("/admin"):
    KEITARO_BASE_URL = KEITARO_BASE_URL[:-6]
if KEITARO_BASE_URL and not KEITARO_BASE_URL.startswith(("http://", "https://")):
    KEITARO_BASE_URL = "https://" + KEITARO_BASE_URL
KEITARO_API_KEY = os.getenv("KEITARO_API_KEY", "")
KEITARO_TIMEOUT = float(os.getenv("KEITARO_TIMEOUT", "20"))
DEFAULT_GROUP_NAME = os.getenv("DEFAULT_GROUP_NAME", "FORTESTS")
DEFAULT_SOURCE_NAME = os.getenv("DEFAULT_SOURCE_NAME", "FORTESTS")
DEFAULT_DOMAIN = os.getenv("DEFAULT_DOMAIN", "")
GOOGLE_URL = os.getenv("GOOGLE_URL", "https://www.google.com")
PORT = int(os.getenv("PORT", "8000"))
