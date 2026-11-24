import { cloneDeep, toMerged } from "es-toolkit";
import type { ISiteMetadata, TSiteID, TSiteUrl } from "./types";

export type TCustomSiteSchema = "Torznab" | "NexusPHP" | "Unit3D";

export interface ICustomSiteDefinitionLike {
  id: TSiteID;
  name: string;
  schema: TCustomSiteSchema;
  type: "private" | "public";
  urls: string[];
  description?: string;
  tags?: string[];
  apiPath?: string;
  requiresApiKey?: boolean;
  timezoneOffset?: string;
  createdAt?: number;
}

const customSiteMap = new Map<TSiteID, ICustomSiteDefinitionLike>();

function normalizeHttpUrl(raw: string): TSiteUrl | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const href = parsed.href;
    return (href.endsWith("/") ? href : `${href}/`) as TSiteUrl;
  } catch {
    return null;
  }
}

export function normalizeCustomSiteUrls(urls: ReadonlyArray<string>): TSiteUrl[] {
  const out: TSiteUrl[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (typeof raw !== "string") continue;
    const normalized = normalizeHttpUrl(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function registerCustomSite(def: ICustomSiteDefinitionLike): void {
  if (!def || typeof def.id !== "string" || !def.id.trim()) return;
  const urls = normalizeCustomSiteUrls(def.urls ?? []);
  if (urls.length === 0) return;
  customSiteMap.set(def.id, {
    ...cloneDeep(def),
    id: def.id.trim(),
    name: def.name?.trim() || def.id.trim(),
    urls,
  });
}

export function unregisterCustomSite(siteId: TSiteID): void {
  customSiteMap.delete(siteId);
}

export function syncCustomSites(
  defs: Record<string, ICustomSiteDefinitionLike> | ReadonlyArray<ICustomSiteDefinitionLike> | undefined | null,
): void {
  customSiteMap.clear();
  if (!defs) return;
  const list = Array.isArray(defs) ? defs : Object.values(defs);
  for (const item of list) {
    if (item && typeof item === "object") {
      registerCustomSite(item);
    }
  }
}

export function getCustomSiteDefinition(siteId: TSiteID): ICustomSiteDefinitionLike | undefined {
  const def = customSiteMap.get(siteId);
  return def ? cloneDeep(def) : undefined;
}

export function isCustomSiteId(siteId: TSiteID): boolean {
  return customSiteMap.has(siteId);
}

export function listCustomSiteIds(): TSiteID[] {
  return Array.from(customSiteMap.keys());
}

/**
 * 将自定义站点定义与对应 schema 基类的 SchemaMetadata 合并为完整 ISiteMetadata。
 */
export function buildCustomSiteMetadata(
  def: ICustomSiteDefinitionLike,
  schemaMetadata: Partial<ISiteMetadata>,
): ISiteMetadata {
  const urls = normalizeCustomSiteUrls(def.urls);
  const base = cloneDeep(schemaMetadata);

  const customMetadata: Partial<ISiteMetadata> = {
    version: 1,
    id: def.id,
    name: def.name || def.id,
    description: def.description ?? "",
    tags: Array.isArray(def.tags) ? [...def.tags] : [],
    type: def.type,
    schema: def.schema,
    urls,
    timezoneOffset: (def.timezoneOffset ||
      (def.schema === "NexusPHP" ? "+0800" : "+0000")) as ISiteMetadata["timezoneOffset"],
  };

  if (def.schema === "Torznab") {
    const apiPath = def.apiPath?.trim() || "/api/torznab";
    customMetadata.search = {
      requestConfig: {
        url: apiPath,
      },
      selectors: {
        id: {
          selector: ["guid", "link"],
        },
      },
    };
    if (def.requiresApiKey !== false) {
      customMetadata.userInputSettingMeta = [
        {
          name: "apikey",
          label: "API Key",
          hint: "Torznab / Prowlarr / Jackett API Key",
          required: true,
        },
      ];
    }
  } else if (def.schema === "Unit3D") {
    if (def.requiresApiKey) {
      customMetadata.userInputSettingMeta = [
        {
          name: "apikey",
          label: "API Key",
          hint: "UNIT3D API Token",
          required: true,
        },
      ];
    }
  }

  const merged = toMerged(base as ISiteMetadata, customMetadata as ISiteMetadata);
  merged.urls = urls;
  merged.tags ??= [];
  merged.timezoneOffset ??= def.schema === "NexusPHP" ? "+0800" : "+0000";
  return merged;
}
