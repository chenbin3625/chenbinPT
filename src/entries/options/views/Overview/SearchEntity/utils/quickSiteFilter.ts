export interface IQuickSiteFilter {
  required: string[];
  exclude: string[];
}

export interface IQuickSiteFilterSelection {
  isAllSelected: boolean;
  selectedSite: string | null;
}

export function getQuickSiteFilterSelection(filter: IQuickSiteFilter): IQuickSiteFilterSelection {
  const hasExcludedSites = filter.exclude.length > 0;

  return {
    isAllSelected: filter.required.length === 0 && !hasExcludedSites,
    selectedSite: filter.required.length === 1 && !hasExcludedSites ? filter.required[0]! : null,
  };
}

export function applyQuickSiteFilter(filter: IQuickSiteFilter, siteId: string | null): void {
  filter.required = siteId ? [siteId] : [];
  filter.exclude = [];
}
