// The sandbox's check of the electrode positions a recording is added with (js/api/demo_admin.js
// op_recordings_register), as electrotag/web/manifest_check.py checks them. A module of its own, loaded when
// recordings are added, so that the sign-in page does not carry it.

/** Why a manifest's electrode_positions cannot be kept, or null (manifest_check.py _positions). */
export function positionsProblem(m) {
  const p = m.electrode_positions;
  if (p === undefined || p === null) return null;
  if (typeof p !== 'object' || !['file', 'standard', 'none'].includes(p.source)) return 'electrode_positions must give a source: file, standard, none';
  if (Object.keys(p).some((k) => k !== 'source' && k !== 'points')) return 'electrode_positions holds only source and points';
  if (p.source !== 'file') return 'points' in p ? 'electrode_positions has points only for the source file' : null;
  if (!p.points || typeof p.points !== 'object' || !Object.keys(p.points).length) return 'electrode_positions.points must give the position of at least one channel';
  for (const [name, xy] of Object.entries(p.points)) {
    if (!m.ch_names.includes(name)) return `electrode_positions.points: '${name}' is not a channel shown`;
    if ((m.channel_types || {})[name] !== 'eeg') return `electrode_positions.points: '${name}' is not an EEG channel`;
    if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 3)) {
      return `electrode_positions.points: '${name}' must be [x, y], two numbers from -3 to 3`;
    }
  }
  return null;
}
