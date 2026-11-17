import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatStreamFilters } from "./formatters.js";

const SELECTED_CAMPAIGN_STORAGE_KEY = "keitaro-flow:selected-campaign";

function getStoredCampaignId() {
  try {
    return window.localStorage.getItem(SELECTED_CAMPAIGN_STORAGE_KEY) || "";
  } catch (error) {
    console.error("Не удалось прочитать выбранную кампанию из локального хранилища браузера", error);
    return "";
  }
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Ошибка запроса (${response.status})`);
  return data;
}

function useNotice() {
  const [notice, setNotice] = useState(null);
  const timer = useRef();
  const show = useCallback((message, kind = "success") => {
    setNotice({ message, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), kind === "error" ? 6000 : 3200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const clear = useCallback(() => setNotice(null), []);
  return [notice, show, clear];
}

function OfferPicker({ value, onSelect, placeholder, onError, onOpenChange }) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef();
  const updateOpen = (nextOpen) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        setOptions(await api(`/offers?q=${encodeURIComponent(query)}`));
      } catch (error) {
        setOptions([]);
        onError?.(error.message, "error");
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => clearTimeout(timer.current);
  }, [open, query]);

  return (
    <div className="offer-picker">
      <input
        value={value ? `[${value.id}] ${value.name}` : query}
        onChange={(event) => {
          onSelect(null);
          setQuery(event.target.value);
          updateOpen(true);
        }}
        onFocus={() => updateOpen(true)}
        onBlur={() => setTimeout(() => updateOpen(false), 140)}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={placeholder}
      />
      {open && (
        <div className="picker-menu">
          {loading && <div className="picker-empty">Ищем офферы…</div>}
          {!loading && options.map((offer) => (
            <button
              type="button"
              className="picker-option"
              key={offer.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onSelect(offer);
                setQuery("");
                updateOpen(false);
              }}
            >
              <span className="offer-id">#{offer.id}</span>
              <span>{offer.name}</span>
              {offer.country && <span className="picker-country">{offer.country}</span>}
            </button>
          ))}
          {!loading && options.length === 0 && (
            <div className="picker-empty">{query ? "Совпадений нет" : "Введите название или ID"}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ page, setPage }) {
  return (
    <header className="topbar">
      <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
        <span className="brand-mark">K</span>
        <span>keitaro<span className="brand-light">flow</span></span>
      </a>
      <nav className="topnav" aria-label="Основная навигация">
        <button className={page === "editor" ? "nav-link selected" : "nav-link"} onClick={() => setPage("editor")}>Кампании</button>
        <button className={page === "create" ? "nav-link selected" : "nav-link"} onClick={() => setPage("create")}>Новая кампания</button>
      </nav>
      <div className="environment"><span className="online-dot" /> Keitaro подключение</div>
    </header>
  );
}

function allocateShares(items, total) {
  if (!items.length) return [];
  const base = Math.floor(total / items.length);
  const remainder = total % items.length;
  return items.map((_, index) => base + (index < remainder ? 1 : 0));
}

function balanceDraftOffers(offers) {
  const active = offers.filter((item) => item.active);
  const pinnedTotal = active.filter((item) => item.pinned).reduce((sum, item) => sum + item.share, 0);
  const flexible = active.filter((item) => !item.pinned);
  const shares = allocateShares(flexible, 100 - pinnedTotal);
  const nextShares = new Map(flexible.map((item, index) => [item.offer_id, shares[index]]));
  return offers.map((item) => ({
    ...item,
    share: item.active ? (item.pinned ? item.share : nextShares.get(item.offer_id)) : 0,
  }));
}

function setDraftOfferShare(offers, offerId, requestedShare) {
  const active = offers.filter((item) => item.active);
  const target = active.find((item) => item.offer_id === offerId);
  if (!target || target.pinned) return offers;
  const pinnedTotal = active.filter((item) => item.pinned).reduce((sum, item) => sum + item.share, 0);
  const others = active.filter((item) => !item.pinned && item.offer_id !== offerId);
  const maxShare = 100 - pinnedTotal;
  if (maxShare < 0) throw new Error("Закреплённые офферы уже занимают больше 100%");
  const share = Math.min(maxShare, Math.max(0, requestedShare));
  if (!others.length && share !== maxShare) {
    throw new Error(`Единственный незакреплённый оффер должен иметь долю ${maxShare}%`);
  }
  const targetShare = share;
  const otherShares = allocateShares(others, maxShare - targetShare);
  const shares = new Map([
    [offerId, targetShare],
    ...others.map((item, index) => [item.offer_id, otherShares[index]]),
  ]);
  return offers.map((item) => item.active && !item.pinned
    ? { ...item, share: shares.get(item.offer_id) }
    : item);
}

function draftOfferChanged(original, draft) {
  if (!original) return true;
  return original.active !== draft.active
    || original.pinned !== draft.pinned
    || (draft.active ? original.share !== draft.share : original.last_share !== draft.last_share);
}

function getDraftOffers(stream, drafts) {
  const streamDrafts = drafts[stream.id] || {};
  const originalIds = new Set(stream.offers.map((item) => item.offer_id));
  return [
    ...stream.offers.map((item) => ({
      ...item,
      ...(streamDrafts[item.offer_id] || {}),
    })),
    ...Object.values(streamDrafts).filter((item) => !originalIds.has(item.offer_id)),
  ];
}

function createInitialDrafts(data) {
  return Object.fromEntries(data.streams.map((stream) => {
    const offers = stream.offers.map((item) => ({
      ...item,
      share: item.active ? item.share : 0,
      last_share: item.last_share ?? item.share,
    }));
    const activeTotal = offers.filter((item) => item.active).reduce((sum, item) => sum + item.share, 0);
    const balancedOffers = activeTotal === 100 ? balanceDraftOffers(offers) : offers;
    return [
      stream.id,
      Object.fromEntries(balancedOffers.map((item) => [item.offer_id, item])),
    ];
  }));
}

function OfferRow({ offer, dirty, onActive, onPin, onShare, onShareCommit, saving }) {
  const startingShare = useRef(offer.share);
  const inactive = !offer.active;
  return (
    <tr className={`${inactive ? "offer-row inactive" : "offer-row"}${dirty ? " pending-change" : ""}`}>
      <td className="offer-cell">
        <div className="offer-name">
          <strong>{offer.name}</strong>
          <span>
            #{offer.offer_id}
            {inactive && !offer.available_in_keitaro && <em className="missing-label">Нет в Keitaro</em>}
            {inactive && offer.available_in_keitaro && <em className="paused-label">Отключён</em>}
          </span>
        </div>
      </td>
      <td className="share-cell">
        <div className="share-control">
          <button
            type="button"
            className={`lock-button${offer.pinned ? " locked" : ""}${dirty ? " pending-control" : ""}`}
            title={offer.pinned ? "Открепить долю" : "Закрепить текущую долю"}
            aria-label={offer.pinned ? `Открепить долю оффера ${offer.offer_id}` : `Закрепить долю оффера ${offer.offer_id}`}
            aria-pressed={offer.pinned}
            disabled={saving || inactive}
            onClick={() => onPin(offer)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4.5" y="10" width="15" height="11" rx="2" />
              {offer.pinned
                ? <path d="M7.5 10V7a4.5 4.5 0 0 1 9 0v3" />
                : <path d="M7.5 10V7a4.5 4.5 0 0 1 8.7-1.6" />}
              <path d="M12 14v3" />
            </svg>
          </button>
          {offer.active
            ? <>
              <input
                type="number"
                min="0"
                max="100"
                value={offer.share}
                className={dirty ? "pending-control" : ""}
                disabled={saving || offer.pinned}
                onFocus={() => { startingShare.current = offer.share; }}
                onChange={(event) => onShare(offer, event.target.value)}
                onBlur={(event) => {
                  if (Number(event.currentTarget.value) !== startingShare.current) onShareCommit(offer);
                }}
                aria-label={`Доля оффера ${offer.offer_id}`}
              />
              <span>%</span>
            </>
            : <span className={`stored-share${dirty ? " pending-control" : ""}`}>{offer.share}%</span>}
        </div>
      </td>
      <td className="stats-number">{offer.clicks.toLocaleString("ru-RU")}</td>
      <td className="stats-number">{offer.unique_clicks.toLocaleString("ru-RU")}</td>
      <td className="stats-number">{offer.bots.toLocaleString("ru-RU")}</td>
      <td className="action-cell">
        <button
          className={`${inactive ? "toggle" : "toggle on"}${dirty ? " pending-control" : ""}`}
          type="button"
          role="switch"
          aria-checked={offer.active}
          aria-label={`${offer.active ? "Деактивировать" : "Активировать"} оффер ${offer.offer_id}`}
          disabled={saving || (inactive && !offer.available_in_keitaro)}
          onClick={() => onActive(offer)}
        ><span /></button>
      </td>
    </tr>
  );
}

function App() {
  const [page, setPage] = useState("editor");
  const [notice, notify, clearNotice] = useNotice();
  const [meta, setMeta] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [query, setQuery] = useState("");
  const [campaignId, setCampaignId] = useState(getStoredCampaignId);
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [offer, setOffer] = useState(null);
  const [form, setForm] = useState({ name: "", geo: "", domain_id: "", group_id: "", source_id: "" });
  const [created, setCreated] = useState(null);
  const [addOffer, setAddOffer] = useState(null);
  const [addShare, setAddShare] = useState("");
  const [openPickerStreamId, setOpenPickerStreamId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  const hasPendingDrafts = useMemo(() => view?.streams.some((stream) => (
    getDraftOffers(stream, drafts).some((item) => draftOfferChanged(
      stream.offers.find((original) => original.offer_id === item.offer_id),
      item,
    ))
  )) || false, [drafts, view]);

  const activeOfferCount = useMemo(
    () => view?.streams.reduce((count, stream) => (
      count + getDraftOffers(stream, drafts).filter((item) => item.active).length
    ), 0) || 0,
    [drafts, view],
  );

  const loadMeta = useCallback(async () => {
    try {
      const data = await api("/meta");
      setMeta(data);
      setForm((current) => ({
        ...current,
        domain_id: current.domain_id || data.defaults.domain_id || "",
        group_id: current.group_id || data.defaults.group_id || "",
        source_id: current.source_id || data.defaults.source_id || "",
      }));
    } catch (error) {
      notify(error.message, "error");
    }
  }, [notify]);

  const loadCampaigns = useCallback(async (filter = query) => {
    try {
      const list = await api(`/campaigns?q=${encodeURIComponent(filter)}`);
      setCampaigns(list);
      if (list.length && !list.some((item) => String(item.id) === campaignId)) {
        if (hasPendingDrafts && !window.confirm("Есть несохранённые изменения. Сбросить их и открыть другую кампанию?")) return list;
        setCampaignId(String(list[0].id));
      }
      if (!list.length) {
        if (hasPendingDrafts && !window.confirm("Есть несохранённые изменения. Сбросить их?")) return list;
        setCampaignId("");
        setView(null);
      }
      return list;
    } catch (error) {
      notify(error.message, "error");
      return [];
    }
  }, [campaignId, hasPendingDrafts, notify, query]);

  const loadView = useCallback(async (id = campaignId) => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api(`/campaigns/${id}`);
      setView(data);
      const initialDrafts = createInitialDrafts(data);
      draftsRef.current = initialDrafts;
      setDrafts(initialDrafts);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [campaignId, notify]);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => { loadCampaigns(""); }, []); // Initial campaign list.
  useEffect(() => {
    try {
      if (campaignId) {
        window.localStorage.setItem(SELECTED_CAMPAIGN_STORAGE_KEY, campaignId);
      } else {
        window.localStorage.removeItem(SELECTED_CAMPAIGN_STORAGE_KEY);
      }
    } catch (error) {
      console.error("Не удалось сохранить выбранную кампанию в локальное хранилище браузера", error);
      notify("Не удалось сохранить выбранную кампанию в этом браузере", "error");
    }
  }, [campaignId, notify]);
  useEffect(() => {
    if (page === "editor" && campaignId) loadView();
  }, [page, campaignId, loadView]);

  const updateStreamDraft = (streamId, offers) => {
    const nextDrafts = {
      ...draftsRef.current,
      [streamId]: Object.fromEntries(offers.map((item) => [item.offer_id, item])),
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  };

  const setOfferState = (stream, item, patch) => {
    const offers = getDraftOffers(stream, draftsRef.current);
    const target = offers.find((entry) => entry.offer_id === item.offer_id);
    if (!target) return;
    if (typeof patch.active === "boolean") {
      if (patch.active) {
        if (!target.available_in_keitaro) {
          notify(`Оффер ${target.offer_id} сначала нужно восстановить в Keitaro`, "error");
          return;
        }
        const pinnedTotal = offers
          .filter((entry) => entry.active && entry.pinned)
          .reduce((sum, entry) => sum + entry.share, 0);
        if (pinnedTotal >= 100) {
          notify("Закреплённые офферы уже занимают 100%", "error");
          return;
        }
        target.active = true;
        target.pinned = false;
        updateStreamDraft(stream.id, balanceDraftOffers(offers));
        return;
      }
      if (offers.filter((entry) => entry.active).length <= 1) {
        notify("Нельзя деактивировать последний активный оффер потока", "error");
        return;
      }
      target.last_share = target.share;
      target.share = 0;
      target.active = false;
      target.pinned = false;
      updateStreamDraft(stream.id, balanceDraftOffers(offers));
      return;
    }
    if (typeof patch.pinned === "boolean") {
      target.pinned = patch.pinned;
      updateStreamDraft(stream.id, balanceDraftOffers(offers));
    }
  };

  const updateShareDraft = (stream, item, value) => {
    const parsed = Number.parseInt(value, 10);
    const requested = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
    const offers = getDraftOffers(stream, draftsRef.current).map((entry) => (
      entry.offer_id === item.offer_id ? { ...entry, share: requested } : entry
    ));
    updateStreamDraft(stream.id, offers);
  };

  const redistributeDraft = (stream, item) => {
    const offers = getDraftOffers(stream, draftsRef.current);
    const target = offers.find((entry) => entry.offer_id === item.offer_id);
    if (!target) return;
    try {
      updateStreamDraft(stream.id, setDraftOfferShare(
        offers,
        item.offer_id,
        target.share,
      ));
    } catch (error) {
      notify(error.message, "error");
    }
  };

  const applyDraft = async (stream) => {
    const offers = getDraftOffers(stream, draftsRef.current);
    const active = offers.filter((item) => item.active);
    const total = active.reduce((sum, item) => sum + item.share, 0);
    if (total !== 100) {
      notify(`Сумма должна быть 100%, сейчас ${total}%`, "error");
      return;
    }
    setSaving(true);
    try {
      await api(`/campaigns/${view.campaign.id}/streams/${stream.id}/offers`, {
        method: "PUT",
        body: {
          offers: offers.map((item) => ({
            offer_id: item.offer_id,
            active: item.active,
            pinned: item.active && item.pinned,
            share: item.active ? item.share : 0,
            last_share: item.active ? item.share : item.last_share,
          })),
        },
      });
      await loadView();
      notify("Изменения применены");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const resetDraft = (stream) => {
    const nextDrafts = {
      ...draftsRef.current,
      [stream.id]: Object.fromEntries(stream.offers.map((item) => [item.offer_id, {
        ...item,
        share: item.active ? item.share : 0,
        last_share: item.last_share ?? item.share,
      }])),
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  };

  const addOfferToStream = (stream) => {
    if (!addOffer) return notify("Выберите оффер из списка", "error");
    const offers = getDraftOffers(stream, draftsRef.current);
    const existing = offers.find((item) => item.offer_id === addOffer.id);
    if (existing) {
      if (existing.active) return notify("Этот оффер уже активен в потоке", "error");
      if (!existing.available_in_keitaro) {
        return notify(`Оффер ${existing.offer_id} сначала нужно восстановить в Keitaro`, "error");
      }
      return setOfferState(stream, existing, { active: true });
    }
    const active = offers.filter((item) => item.active);
    const pinnedTotal = active.filter((item) => item.pinned).reduce((sum, item) => sum + item.share, 0);
    const available = 100 - pinnedTotal;
    if (available < 1) return notify("Закреплённые офферы уже занимают 100%", "error");
    const flexibleCount = active.filter((item) => !item.pinned).length;
    const autoShares = allocateShares(Array.from({ length: flexibleCount + 1 }, () => ({})), available);
    const requested = addShare ? Number(addShare) : autoShares[flexibleCount];
    if (!Number.isInteger(requested) || requested < 1 || requested > available) {
      return notify(`Доля нового оффера должна быть от 1 до ${available}%`, "error");
    }
    const stagedOffer = {
      offer_id: addOffer.id,
      name: addOffer.name || `#${addOffer.id}`,
      share: requested,
      last_share: requested,
      active: true,
      pinned: false,
      available_in_keitaro: true,
      clicks: 0,
      unique_clicks: 0,
      bots: 0,
    };
    updateStreamDraft(stream.id, setDraftOfferShare([...offers, stagedOffer], stagedOffer.offer_id, requested));
    setAddOffer(null);
    setAddShare("");
    notify("Оффер добавлен в черновик. Нажмите «Применить изменения» для сохранения");
  };

  const createCampaign = async (event) => {
    event.preventDefault();
    if (!offer) return notify("Выберите оффер из списка", "error");
    setSaving(true);
    try {
      const result = await api("/campaigns", {
        method: "POST",
        body: {
          ...form,
          offer_id: offer.id,
          domain_id: Number(form.domain_id) || null,
          group_id: Number(form.group_id) || null,
          source_id: Number(form.source_id) || null,
        },
      });
      setCreated(result);
      notify("Кампания создана");
      await loadCampaigns("");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="app-shell">
      <Header page={page} setPage={setPage} />
      <main className="page-wrap">
        {page === "editor" ? (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">УПРАВЛЕНИЕ ТРАФИКОМ</div>
                <h1>Кампании</h1>
                <p>Потоки, офферы и распределение трафика в одном месте.</p>
              </div>
              <button className="button primary" onClick={() => { setCreated(null); setPage("create"); }}>＋ Новая кампания</button>
            </div>
            <section className="toolbar card">
              <div className="search-field">
                <span className="search-icon" aria-hidden="true">⌕</span>
                <input
                  value={query}
                  aria-label="Поиск кампаний"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    clearTimeout(window.campaignSearchTimer);
                    window.campaignSearchTimer = setTimeout(() => loadCampaigns(event.target.value), 240);
                  }}
                  placeholder="Найти кампанию по названию или ID"
                />
                {query && (
                  <button
                    className="search-clear"
                    type="button"
                    aria-label="Очистить поиск"
                    title="Очистить поиск"
                    onClick={() => {
                      clearTimeout(window.campaignSearchTimer);
                      setQuery("");
                      loadCampaigns("");
                    }}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m4 4 8 8M12 4l-8 8" />
                    </svg>
                  </button>
                )}
              </div>
              <select
                value={campaignId}
                onChange={(event) => {
                  if (hasPendingDrafts && !window.confirm("Есть несохранённые изменения. Сбросить их и открыть другую кампанию?")) return;
                  setCampaignId(event.target.value);
                }}
                aria-label="Кампания"
              >
                {campaigns.map((campaign) => <option value={campaign.id} key={campaign.id}>#{campaign.id} · {campaign.name}</option>)}
              </select>
            </section>
            {loading && !view ? <div className="loading-state"><span className="spinner" /> Загружаем данные Keitaro…</div> : null}
            {!loading && !campaigns.length && <div className="empty-state card"><div className="empty-icon">↗</div><h2>Пока нет кампаний</h2><p>Создайте кампанию — потоки и первый оффер настроятся автоматически.</p><button className="button primary" onClick={() => setPage("create")}>Создать кампанию</button></div>}
            {view && (
              <>
                <section className="campaign-overview card">
                  <div className="campaign-symbol">↗</div>
                  <div className="campaign-title">
                    <span className="eyebrow">КАМПАНИЯ #{view.campaign.id}</span>
                    <h2>{view.campaign.name}</h2>
                    <span className="campaign-subtitle">Alias: {view.campaign.alias || "—"} <span className="divider">/</span> {view.campaign.state || "—"}</span>
                  </div>
                  <div className="overview-metric"><strong>{view.streams.length}</strong><span>потока</span></div>
                  <div className="overview-metric"><strong>{activeOfferCount}</strong><span>активных оффера</span></div>
                  <span className={view.campaign.state === "active" ? "status-pill active-status" : "status-pill"}>{view.campaign.state || "неизвестно"}</span>
                </section>
                {view.stats_error && <div className="inline-alert">Статистика недоступна: {view.stats_error}</div>}
                <div className="section-title-row">
                  <div>
                    <h2>Потоки кампании</h2>
                    <p>Закреплённая доля сохраняется, пока вы не открепите оффер.</p>
                  </div>
                </div>
                {view.streams.map((stream, streamIndex) => {
                  const streamOffers = getDraftOffers(stream, drafts);
                  const draftTotal = streamOffers.filter((item) => item.active)
                    .reduce((sum, item) => sum + item.share, 0);
                  const streamDirty = streamOffers.some((item) => draftOfferChanged(
                    stream.offers.find((original) => original.offer_id === item.offer_id),
                    item,
                  ));
                  const filterDescription = formatStreamFilters(stream.filters);
                  const reservePickerSpace = streamIndex === view.streams.length - 1
                    && openPickerStreamId === stream.id;
                  return (
                    <section className={`stream-card card${reservePickerSpace ? " picker-space-reserved" : ""}`} key={stream.id}>
                      <div className="stream-heading">
                        <div className="stream-title-wrap">
                          <span className="stream-icon">↗</span>
                          <div>
                            <h3>{stream.editable ? "Offer" : stream.name || `Поток ${stream.id}`}</h3>
                            {!stream.editable && <span>Поток #{stream.id} <span className="divider">/</span> {stream.schema}</span>}
                          </div>
                        </div>
                        <span className="stream-badge">{stream.editable ? `${streamOffers.filter((item) => item.active).length} активных` : "Без офферов"}</span>
                      </div>
                      {filterDescription && <div className="stream-filter">Фильтры: {filterDescription}</div>}
                      {stream.share_warning && <div className="inline-alert stream-alert">{stream.share_warning}</div>}
                      {!stream.editable ? (
                        <div className="readonly-note">Этот поток не содержит офферов для управления.</div>
                      ) : (
                        <>
                          <div className="stream-controls">
                            <div className="distribution-hint">
                              Закрытый замок фиксирует долю; открытый позволяет перераспределять её.
                              {streamDirty && <strong className="pending-label"> Есть несохранённые изменения</strong>}
                            </div>
                            <div className="stream-actions">
                              <button className="button secondary reset-button" disabled={saving || !streamDirty} onClick={() => resetDraft(stream)}>Сбросить</button>
                              <button className="button primary save-button" disabled={saving || !streamDirty || draftTotal !== 100} onClick={() => applyDraft(stream)}>Применить изменения</button>
                            </div>
                          </div>
                          <div className="table-scroll">
                            <table className="offers-table">
                              <thead><tr><th>ОФФЕР</th><th>ДОЛЯ</th><th>КЛИКИ</th><th>УНИКАЛЬНЫЕ</th><th>БОТЫ</th><th>АКТИВНОСТЬ</th></tr></thead>
                              <tbody>
                                {streamOffers.map((item) => (
                                  <OfferRow
                                    key={item.offer_id}
                                    offer={item}
                                    dirty={draftOfferChanged(
                                      stream.offers.find((original) => original.offer_id === item.offer_id),
                                      item,
                                    )}
                                    onActive={(selected) => setOfferState(stream, selected, { active: !selected.active })}
                                    onPin={(selected) => setOfferState(stream, selected, { pinned: !selected.pinned })}
                                    onShare={(selected, value) => updateShareDraft(stream, selected, value)}
                                    onShareCommit={(selected) => redistributeDraft(stream, selected)}
                                    saving={saving}
                                  />
                                ))}
                                {!streamOffers.length && <tr><td colSpan="6" className="empty-row">Добавьте первый оффер, чтобы распределять трафик.</td></tr>}
                              </tbody>
                              <tfoot><tr><td>ИТОГО АКТИВНЫЕ</td><td className={draftTotal === 100 ? "total-ok" : "total-error"}>{draftTotal}%</td><td>{stream.totals.clicks.toLocaleString("ru-RU")}</td><td>{stream.totals.unique_clicks.toLocaleString("ru-RU")}</td><td>{stream.totals.bots.toLocaleString("ru-RU")}</td><td /></tr></tfoot>
                            </table>
                          </div>
                          <div className="add-offer-row">
                            <div className="add-picker"><OfferPicker value={addOffer} onSelect={setAddOffer} placeholder="Добавить оффер по названию или ID" onError={notify} onOpenChange={(isOpen) => setOpenPickerStreamId(isOpen ? stream.id : null)} /></div>
                            <label className="add-share"><input type="number" min="1" max="100" value={addShare} onChange={(event) => setAddShare(event.target.value)} placeholder="Авто" aria-label="Доля нового оффера" /><span>%</span></label>
                            <button className="button primary" disabled={saving || !addOffer} onClick={() => addOfferToStream(stream)}>Добавить в черновик</button>
                          </div>
                          {streamOffers.some((item) => !item.active && !item.available_in_keitaro) && (
                            <div className="missing-note">Офферы, удалённые из Keitaro, сохранены здесь. Они останутся неактивными; включение доступно после восстановления оффера в Keitaro.</div>
                          )}
                        </>
                      )}
                    </section>
                  );
                })}
              </>
            )}
          </>
        ) : (
          <div className="create-layout">
            <section className="create-intro">
              <div className="eyebrow">БЫСТРЫЙ ЗАПУСК</div>
              <h1>Новая кампания</h1>
              <p>Задайте параметры — Keitaro Flow создаст кампанию и подготовит потоки.</p>
              <div className="create-steps">
                <div className="step"><span>01</span><div><strong>Гео-поток</strong><small>Указанные страны направляются на Google</small></div></div>
                <div className="step"><span>02</span><div><strong>Оффер-поток</strong><small>Остальной трафик направляется на выбранный оффер</small></div></div>
              </div>
            </section>
            <section className="create-card card">
              <div className="card-title"><div><h2>Параметры кампании</h2><p>Поля со звёздочкой обязательны</p></div><span className="required-note">* обязательное поле</span></div>
              <form onSubmit={createCampaign}>
                <label className="form-field"><span>Название кампании <b>*</b></span><input required maxLength="200" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Например, Autumn AU test" /><small>Префикс <code>test_</code> и суффикс <code>_campaign</code> добавятся автоматически.</small></label>
                <label className="form-field"><span>Гео <b>*</b></span><input required minLength="2" value={form.geo} onChange={(event) => setForm({ ...form, geo: event.target.value })} placeholder="AU, MX, RO" /><small>Двухбуквенные коды стран через запятую</small></label>
                <label className="form-field"><span>Стартовый оффер <b>*</b></span><OfferPicker value={offer} onSelect={setOffer} placeholder="Найдите оффер в Keitaro" onError={notify} /></label>
                <details className="advanced-settings">
                  <summary>Дополнительные настройки <span>Домен, группа и источник — только просмотр</span></summary>
                  <div className="select-grid">
                    <label className="form-field"><span>Домен</span><select value={form.domain_id} disabled><option value="">Выбрать домен</option>{meta?.domains.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    <label className="form-field"><span>Группа</span><select value={form.group_id} disabled><option value="">Выбрать группу</option>{meta?.groups.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                    <label className="form-field"><span>Источник</span><select value={form.source_id} disabled><option value="">Выбрать источник</option>{meta?.sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  </div>
                </details>
                <button className="button primary create-submit" type="submit" disabled={saving}>{saving ? "Создаём кампанию…" : "Создать кампанию"} <span>→</span></button>
              </form>
              {created && <div className="created-result"><span className="success-check">✓</span><div><strong>Кампания создана</strong><p>#{created.campaign_id} · {created.name}{created.tracking_url && <><br /><a href={created.tracking_url} target="_blank" rel="noreferrer">{created.tracking_url}</a></>}</p><button className="text-button" onClick={() => { setCampaignId(String(created.campaign_id)); setPage("editor"); }}>Открыть в редакторе →</button></div></div>}
            </section>
          </div>
        )}
      </main>
      <footer className="footer"><span>Keitaro Flow</span><span>Управление кампаниями и трафиком</span></footer>
      {notice && <div className={`toast ${notice.kind}`} role="status">{notice.kind === "error" ? "!" : "✓"} <span>{notice.message}</span><button aria-label="Закрыть уведомление" onClick={clearNotice}>×</button></div>}
    </div>
  );
}

export default App;
