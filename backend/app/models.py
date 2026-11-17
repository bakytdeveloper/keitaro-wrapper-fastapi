from datetime import datetime
from sqlalchemy import String, Integer, Float, Boolean, DateTime, Text, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base

class CampaignRecord(Base):
    __tablename__ = "campaign_records"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    keitaro_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    geo: Mapped[str] = mapped_column(String(255))
    offer_id: Mapped[int] = mapped_column(Integer)
    domain_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    group_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    google_stream_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    offer_stream_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class CampaignOffer(Base):
    __tablename__ = "campaign_offers"
    __table_args__ = (UniqueConstraint("campaign_id", "stream_id", "offer_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(Integer, index=True)
    stream_id: Mapped[int] = mapped_column(Integer)
    offer_id: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(500), default="")
    share: Mapped[int] = mapped_column(Integer, default=0)
    last_share: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class OfferChange(Base):
    __tablename__ = "offer_changes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    campaign_id: Mapped[int] = mapped_column(Integer, index=True)
    stream_id: Mapped[int] = mapped_column(Integer)
    offer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(50))
    shares_after: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
