import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.service import geo_codes, split

def test_geo_normalization():
    assert geo_codes("mx, AU;mx") == ["MX", "AU"]

def test_geo_validation():
    try:
        geo_codes("USA")
    except ValueError as exc:
        assert "ISO-код" in str(exc)
    else:
        raise AssertionError("invalid geo must fail")

def test_integer_split():
    assert split(3, 100) == [34, 33, 33]
