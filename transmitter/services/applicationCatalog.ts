export interface InstalledApplication { id: string; name: string; icon?: string }

/** Catalogs stay separate by device. Names are searchable, IDs remain the launch value. */
export function filterApplications(apps: readonly InstalledApplication[], query: string): InstalledApplication[] {
  const term = query.trim().toLocaleLowerCase();
  return apps.filter(app => app.name.toLocaleLowerCase().includes(term))
    .sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(term)) - Number(a.name.toLocaleLowerCase().startsWith(term)) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function sanitizeApplications(value: unknown): InstalledApplication[] {
  if (!Array.isArray(value)) throw new Error('Could not read the installed app list. Refresh and try again.');
  const seen = new Set<string>();
  const apps: InstalledApplication[] = [];
  for (const row of value.slice(0, 5000)) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 2048 || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 160 || /[\u0000-\u001f\u007f]/u.test(entry.id + entry.name) || seen.has(entry.id)) continue;
    const app: InstalledApplication = { id: entry.id, name: entry.name.trim() };
    if (typeof entry.icon === 'string' && entry.icon.length <= 128_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(entry.icon)) app.icon = entry.icon;
    apps.push(app); seen.add(app.id);
  }
  return filterApplications(apps, '');
}
