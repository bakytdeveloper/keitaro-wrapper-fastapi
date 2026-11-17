import re, json, unicodedata
from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import CampaignRecord, CampaignOffer, OfferChange
from . import config
from .keitaro import KeitaroError

def arr(x): return x if isinstance(x, list) else []
def num(x): return int(x or 0)
def geo_codes(raw):
    parts = [x.upper() for x in re.split(r"[,;\s]+", str(raw or "")) if x]
    if not parts: raise ValueError("Укажите хотя бы один гео-код, например: MX,AU,RO")
    invalid = [x for x in parts if not re.fullmatch(r"[A-Z]{2}", x)]
    if invalid: raise ValueError("Некорректные гео-коды (нужен ISO-код из 2 букв): " + ", ".join(invalid))
    return list(dict.fromkeys(parts))
def split(count, total=100):
    if count <= 0: return []
    return [total//count + (1 if i < total%count else 0) for i in range(count)]
def rebalance(offers):
    active=[o for o in offers if o.active]
    pinned=sum(o.share for o in active if o.pinned)
    if pinned>100: raise ValueError("Закреплённые доли не могут превышать 100%")
    free=[o for o in active if not o.pinned]; remain=100-pinned
    if not free and remain: raise ValueError("Невозможно распределить остаток: открепите один из офферов")
    for o,v in zip(free,split(len(free),remain)): o.share=v
    for o in offers:
        if not o.active: o.share=0
    return offers
class CampaignService:
    def __init__(self, db: Session, client):
        self.db,self.client=db,client
    def defaults(self):
        domains=arr(self.client.list_domains()); groups=arr(self.client.list_groups()); sources=arr(self.client.list_sources())
        clean=lambda x: re.sub(r"/+$","",re.sub(r"^https?://","",str(x or "").strip(),flags=re.I)).lower()
        find=lambda items,name,key=lambda x:str(x or "").strip().lower(): next((x for x in items if key(x.get("name"))==key(name)),None)
        domain=find(domains,config.DEFAULT_DOMAIN,clean) if config.DEFAULT_DOMAIN else (domains[0] if len(domains)==1 else None)
        group=find(groups,config.DEFAULT_GROUP_NAME); source=find(sources,config.DEFAULT_SOURCE_NAME)
        return {"domains":[{"id":x["id"],"name":x["name"]} for x in domains],"groups":[{"id":x["id"],"name":x["name"]} for x in groups],"sources":[{"id":x["id"],"name":x["name"]} for x in sources],"defaults":{"domain_id":domain.get("id") if domain else None,"group_id":group.get("id") if group else None,"source_id":source.get("id") if source else None,"name_prefix":"test_"}}
    def search_offers(self,q="",limit=20):
        q=q.strip().lower()
        return [{"id":o["id"],"name":o.get("name",""),"country":o.get("country")} for o in arr(self.client.list_offers()) if not q or q in str(o.get("name","")).lower() or q==str(o.get("id"))][:limit]
    def _catalog(self): return {num(o.get("id")):o for o in arr(self.client.list_offers())}
    def create_campaign(self,name,geo,offer_id,domain_id=None,group_id=None,source_id=None):
        geos=geo_codes(geo); entered=name.strip()
        if not entered: raise ValueError("Название кампании не может быть пустым")
        suffix=re.sub(r"^test(?:[_\\s-]+|$)","",entered,flags=re.I)
        suffix=re.sub(r"(?:[_\\s-]+(?:company|campaign))$","",suffix,flags=re.I).strip()
        final="test_"+(suffix+"_" if suffix else "")+"campaign"
        d=self.defaults()["defaults"]
        missing=[label for label,val in [("домен",d["domain_id"]),("группа",d["group_id"]),("источник",d["source_id"])] if not val]
        if missing: raise ValueError("Не настроены обязательные параметры ("+", ".join(missing)+"). Укажите DEFAULT_DOMAIN, DEFAULT_GROUP_NAME и DEFAULT_SOURCE_NAME в .env и перезапустите сервер.")
        catalog=self._catalog(); offer=catalog.get(offer_id)
        if not offer: raise LookupError(f"Оффер с ID {offer_id} не найден в Keitaro")
        existing=arr(self.client.list_campaigns())
        if any(x.get("name")==final for x in existing): raise FileExistsError(f"Кампания с именем «{final}» уже существует")
        base=unicodedata.normalize("NFKD",final).encode("ascii","ignore").decode().lower()
        base=re.sub(r"[^a-z0-9]+","-",base).strip("-") or "campaign"
        used={str(x.get("alias","")).lower() for x in existing}; alias=base; i=2
        while alias in used: alias=f"{base}-{i}"; i+=1
        campaign=self.client.create_campaign({"name":final,"alias":alias,"type":"position","state":"active","cookies_ttl":24,"domain_id":d["domain_id"],"group_id":d["group_id"],"traffic_source_id":d["source_id"],"cost_type":"CPC","cost_value":0,"cost_currency":"USD","cost_auto":True})
        try:
            google=self.client.create_stream({"campaign_id":campaign["id"],"type":"regular","name":f"Geo {','.join(geos)} → Google","position":1,"state":"active","schema":"action","action_type":"http","action_payload":config.GOOGLE_URL,"collect_clicks":True,"filter_or":False,"filters":[{"name":"country","mode":"accept","payload":geos}]})
            offer_stream=self.client.create_stream({"campaign_id":campaign["id"],"type":"regular","name":f"Offer {offer_id}","position":2,"state":"active","schema":"landings","action_type":"http","collect_clicks":True,"filter_or":False,"filters":[],"offers":[{"offer_id":offer_id,"share":100,"state":"active"}]})
        except Exception:
            try:self.client.delete_campaign(campaign["id"])
            except Exception:pass
            raise
        self.db.add(CampaignRecord(keitaro_id=campaign["id"],name=final,geo=",".join(geos),offer_id=offer_id,domain_id=d["domain_id"],group_id=d["group_id"],source_id=d["source_id"],google_stream_id=google["id"],offer_stream_id=offer_stream["id"]))
        self.db.add(CampaignOffer(campaign_id=campaign["id"],stream_id=offer_stream["id"],offer_id=offer_id,name=offer.get("name",""),share=100,last_share=100,active=True))
        self.db.commit()
        domain=next((x.get("name") for x in arr(self.client.list_domains()) if num(x.get("id"))==num(d["domain_id"])),None)
        clean_domain=re.sub(r"^https?://","",str(domain or ""),flags=re.I).rstrip("/")
        return {"campaign_id":campaign["id"],"name":final,"alias":campaign.get("alias"),"tracking_url":f"https://{clean_domain}/{alias}" if domain else None,"geo":geos,"offer":{"id":offer_id,"name":offer.get("name")},"streams":{"google":google["id"],"offer":offer_stream["id"]}}
    def list_campaigns(self,q=""):
        q=q.strip().lower()
        return sorted([{"id":x.get("id"),"name":x.get("name"),"alias":x.get("alias"),"state":x.get("state")} for x in arr(self.client.list_campaigns()) if not q or q in str(x.get("name","")).lower() or q==str(x.get("id"))],key=lambda x:num(x["id"]),reverse=True)
    def _sync(self,campaign_id,stream,catalog):
        sid=num(stream["id"]); remotes={num(x.get("offer_id")):x for x in arr(stream.get("offers"))}
        rows=list(self.db.scalars(select(CampaignOffer).where(CampaignOffer.campaign_id==campaign_id,CampaignOffer.stream_id==sid)))
        by={x.offer_id:x for x in rows}; changed=False
        for oid,remote in remotes.items():
            live=catalog.get(oid); row=by.get(oid); share=max(0,min(100,num(remote.get("share"))))
            if row is None:
                row=CampaignOffer(campaign_id=campaign_id,stream_id=sid,offer_id=oid,name=(live or {}).get("name",f"#{oid}"),share=share if live else 0,last_share=share,active=bool(live and remote.get("state")!="disabled"),pinned=False); self.db.add(row); rows.append(row); changed=True
            elif not live:
                row.last_share=row.share or row.last_share; row.active=False; row.pinned=False; row.share=0; changed=True
            else:
                row.name=live.get("name") or row.name
                if row.active and not row.pinned: row.share=share; row.last_share=share or row.last_share
        for row in rows:
            if row.active and (row.offer_id not in remotes or row.offer_id not in catalog):
                row.last_share=row.share or row.last_share; row.share=0; row.active=False; row.pinned=False; changed=True
        if changed and any(x.active for x in rows):
            try: rebalance(rows)
            except ValueError: pass
            self.db.flush()
            active=[x for x in rows if x.active and x.offer_id in catalog]
            self.client.update_stream(sid,{"offers":[{"offer_id":x.offer_id,"share":x.share,"state":"active"} for x in active]})
        self.db.flush()
        return rows
    def campaign_view(self,cid):
        try: campaign=self.client.get_campaign(cid)
        except KeitaroError as e:
            if e.status==404: raise LookupError(f"Кампания {cid} не найдена")
            raise
        catalog=self._catalog(); streams=arr(self.client.campaign_streams(cid))
        stats={}; stats_error=None
        for dims in [["stream_id","offer_id"],["stream","offer"]]:
            try:
                report=self.client.build_report({"range":{"interval":"today"},"dimensions":dims,"measures":["clicks","campaign_unique_clicks","bots"],"filters":[{"name":"campaign_id","operator":"EQUALS","expression":cid}],"limit":1000})
                for r in arr(report.get("rows") if report else []):
                    stats[f"{r.get('stream_id')}:{r.get('offer_id')}"]={"clicks":r.get("clicks") or 0,"unique_clicks":r.get("campaign_unique_clicks") or 0,"bots":r.get("bots") or 0}
                break
            except KeitaroError as e: stats_error=e.detail
        views=[]
        for stream in sorted(streams,key=lambda x:x.get("position") or 0):
            editable=stream.get("schema") in ("landings","landings_offers")
            rows=self._sync(cid,stream,catalog) if editable else []
            offers=[]
            for o in sorted(rows,key=lambda x:x.offer_id):
                st=stats.get(f"{stream['id']}:{o.offer_id}",{})
                offers.append({"offer_id":o.offer_id,"name":o.name or f"#{o.offer_id}","share":o.share if o.active else 0,"last_share":o.last_share,"active":o.active,"pinned":o.pinned,"available_in_keitaro":o.offer_id in catalog,"clicks":st.get("clicks",0),"unique_clicks":st.get("unique_clicks",0),"bots":st.get("bots",0)})
            views.append({"id":stream["id"],"name":stream.get("name"),"position":stream.get("position"),"schema":stream.get("schema"),"action_type":stream.get("action_type"),"action_payload":stream.get("action_payload"),"state":stream.get("state"),"filters":stream.get("filters") or [],"editable":editable,"share_warning":None,"offers":offers,"totals":{"clicks":sum(x["clicks"] for x in offers),"unique_clicks":sum(x["unique_clicks"] for x in offers),"bots":sum(x["bots"] for x in offers),"share":sum(x["share"] for x in offers if x["active"])}})
        self.db.commit()
        return {"campaign":{"id":campaign["id"],"name":campaign["name"],"alias":campaign.get("alias"),"state":campaign.get("state")},"streams":views,"stats_error":stats_error}
    def _stream(self,cid,sid):
        stream=self.client.get_stream(sid)
        if num(stream.get("campaign_id"))!=cid: raise LookupError(f"Поток {sid} не принадлежит кампании {cid}")
        if stream.get("schema") not in ("landings","landings_offers"): raise ValueError("В этом потоке нет офферов — редактировать нечего")
        return stream
    def _save(self,cid,sid,offers,action,offer_id=None):
        catalog=self._catalog()
        payload=[{"offer_id":o.offer_id,"share":o.share,"state":"active"} for o in offers if o.active and o.offer_id in catalog]
        self.client.update_stream(sid,{"offers":payload})
        for o in offers:
            row=self.db.scalar(select(CampaignOffer).where(CampaignOffer.campaign_id==cid,CampaignOffer.stream_id==sid,CampaignOffer.offer_id==o.offer_id))
            if row is None: row=o; self.db.add(row)
            row.name=o.name or catalog.get(o.offer_id,{}).get("name",f"#{o.offer_id}")
            row.share=o.share if o.active else 0; row.last_share=o.share if o.active else o.last_share
            row.active=o.active; row.pinned=o.active and o.pinned
        self.db.add(OfferChange(campaign_id=cid,stream_id=sid,offer_id=offer_id,action=action,shares_after=json.dumps({o.offer_id:{"share":o.share if o.active else 0,"active":o.active,"pinned":o.pinned} for o in offers})))
        self.db.commit()
        return self.campaign_view(cid)
    def mutate(self,cid,sid,updates,action="update",offer_id=None):
        stream=self._stream(cid,sid); catalog=self._catalog(); rows=self._sync(cid,stream,catalog)
        by={x.offer_id:x for x in rows}
        for u in updates:
            oid=u["offer_id"]; row=by.get(oid)
            if row is None:
                if oid not in catalog: raise LookupError(f"Оффер {oid} не найден в Keitaro")
                row=CampaignOffer(campaign_id=cid,stream_id=sid,offer_id=oid,name=catalog[oid].get("name",""),active=False,share=0,last_share=0,pinned=False); rows.append(row); by[oid]=row
            active=u.get("active",row.active); pinned=u.get("pinned",row.pinned); share=u.get("share",row.share)
            if active and oid not in catalog: raise FileExistsError(f"Оффер {oid} отсутствует в Keitaro и не может быть активирован")
            if not isinstance(active,bool) or not isinstance(pinned,bool) or not isinstance(share,int) or not 0<=share<=100: raise ValueError(f"Некорректные параметры оффера {oid}")
            if active: row.active=True; row.pinned=pinned; row.share=share; row.last_share=share
            else: row.last_share=row.share or row.last_share; row.active=False; row.pinned=False; row.share=0
        active=[x for x in rows if x.active]
        if not active: raise FileExistsError("Нельзя деактивировать последний активный оффер потока")
        total=sum(x.share for x in active)
        if total!=100: raise ValueError(f"Сумма долей должна быть 100%, сейчас {total}%")
        return self._save(cid,sid,rows,action,offer_id)
