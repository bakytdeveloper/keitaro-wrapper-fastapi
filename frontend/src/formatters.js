function formatFilterValue(value) {
  if (Array.isArray(value)) {
    return value.map(formatFilterValue).filter(Boolean).join(", ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, nestedValue]) => {
      const formatted = formatFilterValue(nestedValue);
      return formatted ? `${key}: ${formatted}` : key;
    }).join(", ");
  }
  return value == null ? "" : String(value);
}

export function formatStreamFilters(filters) {
  if (!Array.isArray(filters)) return "";
  return filters.map((filter) => {
    if (!filter || typeof filter !== "object") return filter == null ? "" : String(filter);
    const nameAndMode = [filter.name, filter.mode ?? filter.operator]
      .filter((value) => value != null && value !== "")
      .map(String)
      .join(" ");
    const payload = formatFilterValue(filter.payload ?? filter.expression);
    return [nameAndMode, payload].filter(Boolean).join(" ");
  }).filter(Boolean).join("; ");
}
