import { useEffect, useState } from "react";
import { listMerchants } from "../api/merchants.js";

export interface MerchantOption {
  id: string;
  displayName: string;
}

/**
 * Loads merchant names through the existing `GET /v1/admin/merchants` list
 * (up to 5 pages of 100). Presentation only: callers still submit the id.
 */
export function useMerchantOptions(): { options: MerchantOption[]; loading: boolean; failed: boolean } {
  const [options, setOptions] = useState<MerchantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: MerchantOption[] = [];
      try {
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const res = await listMerchants({ limit: 100, cursor });
          for (const m of res.merchants) all.push({ id: m.id, displayName: m.displayName });
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }
        all.sort((a, b) => a.displayName.localeCompare(b.displayName));
        if (!cancelled) setOptions(all);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { options, loading, failed };
}

/** Short reference for an id when no name is known. */
export function shortRef(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Name for a merchant id, falling back to a short ref. */
export function merchantLabel(options: MerchantOption[], id: string): string {
  return options.find((o) => o.id === id)?.displayName ?? shortRef(id);
}

interface MerchantPickerProps {
  value: string;
  onChange: (id: string) => void;
  options: MerchantOption[];
  loading: boolean;
  failed: boolean;
  /** Label for the empty choice; omit to make a merchant required. */
  emptyLabel?: string;
  required?: boolean;
  id?: string;
}

/** Merchant name dropdown. Falls back to a plain id field if names fail to load. */
export function MerchantPicker({
  value,
  onChange,
  options,
  loading,
  failed,
  emptyLabel,
  required,
  id,
}: MerchantPickerProps) {
  if (failed) {
    return (
      <input
        id={id}
        type="text"
        value={value}
        required={required}
        placeholder="Merchant ID (names could not be loaded)"
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <select id={id} value={value} required={required} disabled={loading} onChange={(e) => onChange(e.target.value)}>
      <option value="">{loading ? "Loading merchants…" : (emptyLabel ?? "Choose a merchant")}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.displayName} · {shortRef(o.id)}
        </option>
      ))}
    </select>
  );
}
