// Electrode positions for recordings being added from this computer (docs/admin_area.md, "Adding recordings
// from this computer"): the administrator chooses whether to add them, for the topographic map beside the EEG
// (js/annotate/topomap.js). With positions, each recording takes those of its own electrodes.tsv (a BIDS
// sidecar among the files chosen, or chosen afterwards), or, without one, the standard positions of its
// channel names when they are 10-20, 10-10 or 10-05 names; the map positions go into its manifest as
// electrode_positions. Without positions, the manifest says so and the recording has no map. Only the map
// positions of the EEG channels are sent; the files stay on this computer.

import { readElectrodes } from '../eeg/electrodes.js';
import { mapLayout, projectPositions } from '../viewer/head_map.js';
import { registeredPositions } from '../viewer/topo.js';

/** The channels of a manifest as the map takes them. */
export function manifestChannels(m) {
  return (m.ch_names || []).map((name) => ({ name, type: (m.channel_types || {})[name] || 'eeg' }));
}

/**
 * Where each recording's electrodes could be placed: a Map recording ID -> {source: 'file' | 'standard' |
 * 'none', positions (for 'file', Map name -> {x, y}), fileName, placed (EEG channels placed)}.
 */
export async function findPositions(manifests, files) {
  const out = new Map();
  for (const m of manifests) {
    const channels = manifestChannels(m);
    const got = await readElectrodes(files, m.file_name || String(m.recording_id).split('/').pop());
    const positions = got ? projectPositions(got.positions, got.system) : null;
    const fromFile = positions ? registeredPositions(channels, 'file', positions) : null;
    if (fromFile) { out.set(m.recording_id, { source: 'file', positions, fileName: got.fileName, placed: Object.keys(fromFile.points).length }); continue; }
    const layout = mapLayout(channels, null);
    out.set(m.recording_id, layout.source === 'standard'
      ? { source: 'standard', positions: null, fileName: null, placed: layout.points.filter((p) => !p.extra).length }
      : { source: 'none', positions: null, fileName: null, placed: 0 });
  }
  return out;
}

/** A manifest with the electrode positions chosen: `withPositions` false adds it without any. */
export function withElectrodePositions(m, found, withPositions) {
  if (!withPositions || !found || found.source === 'none') return { ...m, electrode_positions: { source: 'none' } };
  const p = registeredPositions(manifestChannels(m), found.source, found.positions);
  return { ...m, electrode_positions: p || { source: 'none' } };
}

/** How a recording's electrodes are placed, in words. */
export function positionsText(source) {
  return { file: 'From its electrodes.tsv', standard: 'Standard positions of its channel names', none: 'None: no topographic map',
    unset: 'Placed by each annotator\'s browser (added before positions were asked for)' }[source] || source;
}
