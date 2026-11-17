from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Any
from .database import Base, engine, get_db
from .keitaro import KeitaroClient, KeitaroError
from .service import CampaignService
from . import config

Base.metadata.create_all(bind=engine)
app=FastAPI(title="Keitaro Wrapper API",version="2.0.0",description="FastAPI + SQLAlchemy backend for Keitaro campaign management")
app.add_middleware(CORSMiddleware,allow_origins=["http://localhost:5173","http://127.0.0.1:5173"],allow_credentials=True,allow_methods=["*"],allow_headers=["*"])
class CampaignIn(BaseModel):
    name:str
    geo:str
    offer_id:int
    domain_id:int|None=None
    group_id:int|None=None
    source_id:int|None=None
class OffersIn(BaseModel):
    offers:list[dict[str,Any]]
def service(db): return CampaignService(db,KeitaroClient())
@app.get("/api/health")
def health(): return {"status":"ok"}
@app.get("/api/meta")
def meta(db:Session=Depends(get_db)):
    try:return service(db).defaults()
    except Exception as e: raise_http(e)
@app.get("/api/offers")
def offers(q:str="",limit:int=20,db:Session=Depends(get_db)):
    try:return service(db).search_offers(q,max(1,min(100,limit)))
    except Exception as e: raise_http(e)
@app.get("/api/campaigns")
def campaigns(q:str="",db:Session=Depends(get_db)):
    try:return service(db).list_campaigns(q)
    except Exception as e: raise_http(e)
@app.post("/api/campaigns",status_code=201)
def create_campaign(body:CampaignIn,db:Session=Depends(get_db)):
    try:return service(db).create_campaign(body.name,body.geo,body.offer_id,body.domain_id,body.group_id,body.source_id)
    except Exception as e: raise_http(e)
@app.get("/api/campaigns/{campaign_id}")
def campaign(campaign_id:int,db:Session=Depends(get_db)):
    try:return service(db).campaign_view(campaign_id)
    except Exception as e: raise_http(e)
@app.put("/api/campaigns/{campaign_id}/streams/{stream_id}/offers")
def update_offers(campaign_id:int,stream_id:int,body:OffersIn,db:Session=Depends(get_db)):
    try:
        updates=[]
        for x in body.offers:
            oid=int(x.get("offer_id",0)); share=x.get("share",0)
            if isinstance(share,bool) or not isinstance(share,int): raise ValueError(f"Некорректная доля для оффера {oid}")
            updates.append({"offer_id":oid,"share":share,"active":x.get("active"),"pinned":x.get("pinned")})
        return service(db).mutate(campaign_id,stream_id,updates)
    except Exception as e: raise_http(e)
@app.get("/api/debug/stream/{stream_id}")
def debug_stream(stream_id:int):
    try:return KeitaroClient().get_stream(stream_id)
    except Exception as e: raise_http(e)
@app.exception_handler(Exception)
async def unhandled(request:Request,exc:Exception):
    status,detail,extra=map_error(exc)
    return JSONResponse(status_code=status,content={"detail":detail,**extra})
def map_error(exc):
    if isinstance(exc,KeitaroError):
        return 502,f"Keitaro API: {exc.detail}",{"path":exc.path,"keitaro_status":exc.status}
    if isinstance(exc,RuntimeError): return 503,str(exc),{}
    if isinstance(exc,LookupError): return 404,str(exc),{}
    if isinstance(exc,FileExistsError): return 409,str(exc),{}
    if isinstance(exc,ValueError): return 400,str(exc),{}
    return 500,"Внутренняя ошибка сервера",{}
def raise_http(exc):
    status,detail,extra=map_error(exc)
    raise HTTPException(status_code=status,detail=detail,headers={"X-Error-Info":str(extra)})

