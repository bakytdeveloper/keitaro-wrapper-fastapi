import httpx
from . import config

class KeitaroError(Exception):
    def __init__(self, status: int, detail: str, path: str):
        self.status, self.detail, self.path = status, detail, path
        super().__init__(detail)

class KeitaroClient:
    def __init__(self):
        if not config.KEITARO_BASE_URL or not config.KEITARO_API_KEY:
            raise RuntimeError("Не заданы KEITARO_BASE_URL / KEITARO_API_KEY в .env")
        self.base = config.KEITARO_BASE_URL + "/admin_api/v1"
        self.client = httpx.Client(timeout=config.KEITARO_TIMEOUT, headers={
            "Api-Key": config.KEITARO_API_KEY, "Accept": "application/json"
        })
    def request(self, method, path, json=None, params=None):
        try:
            response = self.client.request(method, self.base + path, json=json, params=params)
        except httpx.TimeoutException:
            raise KeitaroError(0, "Request timed out", path)
        except httpx.HTTPError as exc:
            raise KeitaroError(0, str(exc), path)
        if not response.is_success:
            raise KeitaroError(response.status_code, response.text[:600], path)
        if not response.content: return None
        try: return response.json()
        except ValueError: raise KeitaroError(response.status_code, "Ответ не JSON — проверьте KEITARO_BASE_URL и API-ключ", path)
    def list_offers(self): return self.request("GET", "/offers")
    def list_domains(self): return self.request("GET", "/domains")
    def list_groups(self, kind="campaigns"): return self.request("GET", "/groups", params={"type":kind})
    def list_sources(self): return self.request("GET", "/traffic_sources")
    def list_campaigns(self): return self.request("GET", "/campaigns")
    def get_campaign(self, i): return self.request("GET", f"/campaigns/{i}")
    def create_campaign(self, payload): return self.request("POST", "/campaigns", payload)
    def delete_campaign(self, i): return self.request("DELETE", f"/campaigns/{i}")
    def campaign_streams(self, i): return self.request("GET", f"/campaigns/{i}/streams")
    def get_stream(self, i): return self.request("GET", f"/streams/{i}")
    def create_stream(self, payload): return self.request("POST", "/streams", payload)
    def update_stream(self, i, payload): return self.request("PUT", f"/streams/{i}", payload)
    def build_report(self, payload): return self.request("POST", "/report/build", payload)
