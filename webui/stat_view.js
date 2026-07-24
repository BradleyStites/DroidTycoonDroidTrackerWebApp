// stat_view.js
//
// Statistics "view" for Droid Tycoon, mirroring the spreadsheet's `Main` /
// `TimeToCompletionCalculations` behavior (see STAT_SPREADSHEET_SPEC.md, tasks
// t_66cd9d7f + t_783c3a3b).
//
// This module is the presentation/compute layer that sits on top of
// stat_tracking.js (the 4-variable persistence). It implements the 6 behaviors
// the spreadsheet performs and renders them to an HTML string for the web UI.
//
// It is runtime-agnostic: all the math helpers are pure (no fs / DOM) so they
// are unit-testable in Node, and the renderer returns a plain HTML string.
//
// Per-minute rate math (verified against the sheet's own formulas):
//   ratePerMin = balanceDelta / (timeDeltaDays * 1440)
// ETA math:
//   minutes = (target - current) / rate
//   then break fractional hours into H / M / S via INT / ROUNDDOWN.

"use strict";

const MINUTES_PER_DAY = 1440;
const NOVA_BASE = 56; // fixed Nova base referenced by the spreadsheet's Main sheet

/**
 * Split a number of minutes into integer hours / minutes / seconds using the
 * spreadsheet's INT + ROUNDDOWN decomposition (spec §4, columns G/H/I/J/K/L/M).
 *
 * @param {number} totalMinutes  estimated minutes to completion
 * @returns {{ hours:number, minutes:number, seconds:number, hms:string }}
 */
function decomposeHMS(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) {
    return { hours: 0, minutes: 0, seconds: 0, hms: "—" };
  }
  const hrs = Math.floor(totalMinutes / 60);
  const remMin = totalMinutes - hrs * 60;
  const mins = Math.floor(remMin);
  const secs = Math.floor((remMin - mins) * 60);
  const hms = `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return { hours: hrs, minutes: mins, seconds: secs, hms };
}

/**
 * Given a rate (credits/min) and the current balance vs a target, return the
 * completion estimate in minutes and the H/M/S decomposition. Mirrors
 * `TimeToCompletionCalculations` E (minutes) + G/H/I/J/K (H/M/S).
 *
 * @param {number} currentCredits
 * @param {number} targetCredits
 * @param {number} ratePerMin   credits per minute (must be > 0)
 * @returns {{ minutes:number, hms:string, hours:number, minutesPart:number, seconds:number }}
 */
function etaToTarget(currentCredits, targetCredits, ratePerMin) {
  if (!ratePerMin || ratePerMin <= 0) {
    return { minutes: Infinity, hms: "—", hours: 0, minutesPart: 0, seconds: 0 };
  }
  const remaining = targetCredits - currentCredits;
  if (remaining <= 0) {
    return { minutes: 0, hms: "00:00:00", hours: 0, minutesPart: 0, seconds: 0 };
  }
  const minutes = remaining / ratePerMin;
  const d = decomposeHMS(minutes);
  return {
    minutes,
    hms: d.hms,
    hours: d.hours,
    minutesPart: d.minutes,
    seconds: d.seconds,
  };
}

/**
 * Convert an offline-earnings figure given in **billions per hour (b/hr)** to
 * a credits-per-minute rate, matching the spreadsheet's `B/Min` column.
 *
 * 1 b/hr = 1,000,000,000 credits / 60 min.
 *
 * @param {number} bhr  offline earnings in billions per hour
 * @returns {number}   credits per minute
 */
function bhrToCreditsPerMin(bhr) {
  return (bhr * 1e9) / 60;
}

/**
 * Build the cumulative-Nova curve for rebirths 12..N. Mirrors the spreadsheet's
 * Main sheet column D and RebirthRequirementsRewards column C.
 *
 * Spreadsheet seeding (spec §5 / §6):
 *   nova(12) = 11, nova(13) = 16
 *   for n >= 14: increment(n) = increment(n-1) + 1 ; nova(n) = nova(n-1) + increment(n)
 * The fixed base of 56 (NOVA_BASE) is the player's running-total floor the
 * dashboard's Nova/hour uses, not a row value here.
 *
 * @param {number} upToRebirth  inclusive upper rebirth (>= 12)
 * @returns {Array<{rebirth:number, nova:number, increment:number}>}
 */
function cumulativeNovaCurve(upToRebirth) {
  const out = [];
  if (upToRebirth < 12) return out;
  let prevNova = 11; // nova(12)
  let prevIncrement = 5; // 11 -> 16 step at rebirth 13
  out.push({ rebirth: 12, nova: 11, increment: 0 });
  if (upToRebirth >= 13) out.push({ rebirth: 13, nova: 16, increment: 5 });
  let curNova = 16;
  let curIncrement = 6; // 16 - 11 + 1
  for (let r = 14; r <= upToRebirth; r++) {
    curNova += curIncrement;
    out.push({ rebirth: r, nova: curNova, increment: curIncrement });
    curIncrement += 1;
  }
  return out;
}

/**
 * Compute the per-rebirth dashboard rows (the `Main` sheet, spec §5). For each
 * upcoming rebirth from `currentRebirth` onward it shows: credits required,
 * the live earning rate (credits/min), estimated completion in days and hours,
 * the cumulative Nova reward, and Nova throughput (Nova/min).
 *
 * @param {object} stats            a validated StatRecord (from stat_tracking)
 * @param {Array}  costTable        rows [{rebirth, credits, nova}] from rebirth_cost
 * @returns {Array<object>}  one row per upcoming rebirth (ascending)
 */
function buildDashboard(stats, costTable) {
  const ratePerMin = bhrToCreditsPerMin(stats.offlineEarningsBhr);
  const rows = [];
  const startRb = stats.currentRebirth;
  for (const row of costTable) {
    if (row.rebirth < startRb) continue;
    const creditsRequired = row.credits;
    const nova = row.nova == null ? null : row.nova;
    // ETC days = credits / (rate/min) / 1440 ; hours = /60
    let etcDays = null;
    let etcHours = null;
    let novaPerMin = null;
    if (ratePerMin > 0) {
      const minutes = (creditsRequired - stats.currentCredits) / ratePerMin;
      etcDays = minutes > 0 ? minutes / MINUTES_PER_DAY : 0;
      etcHours = minutes > 0 ? minutes / 60 : 0;
      if (nova != null) novaPerMin = nova / Math.max(minutes, 1e-9);
    }
    rows.push({
      rebirth: row.rebirth,
      creditsRequired,
      nova,
      ratePerMin,
      etcDays,
      etcHours,
    });
  }
  return rows;
}

/**
 * Format a number for display: thousands separators, fixed decimals.
 * @param {number} n
 * @param {number} [decimals=0]
 */
function fmtNum(n, decimals = 0) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Render the full statistics view as an HTML string. Mirrors the spreadsheet's
 * style: a current-values summary, the earning-rate block, and the per-rebirth
 * dashboard table with cumulative Nova + ETA + Nova/min.
 *
 * @param {object} stats        validated StatRecord
 * @param {Array}  costTable    [{rebirth, credits, nova}]
 * @returns {string}  HTML
 */
function renderStatsView(stats, costTable) {
  const ratePerMin = bhrToCreditsPerMin(stats.offlineEarningsBhr);
  const dash = buildDashboard(stats, costTable);
  const novaCurve = cumulativeNovaCurve(Math.max(stats.currentRebirth, 28));
  const nowNova = novaCurve.length ? novaCurve[novaCurve.length - 1].nova : 0;

  const rowsHtml = dash.map((r) => {
    const reqFmt = fmtNum(r.creditsRequired);
    const etcDays = r.etcDays == null ? "—" : fmtNum(r.etcDays, 2);
    const etcHours = r.etcHours == null ? "—" : fmtNum(r.etcHours, 2);
    const nova = r.nova == null ? "—" : fmtNum(r.nova);
    return `
        <tr>
          <td>${r.rebirth}</td>
          <td>${reqFmt}</td>
          <td>${fmtNum(r.ratePerMin, 2)}</td>
          <td>${etcDays}</td>
          <td>${etcHours}</td>
          <td>${nova}</td>
        </tr>`;
  }).join("");

  return `
  <div class="stats-summary">
    <div class="stat"><div class="stat-label">Super Rebirth Cycle</div><div class="stat-value">${stats.currentSuperRebirthCycle}</div></div>
    <div class="stat"><div class="stat-label">Rebirth</div><div class="stat-value">${stats.currentRebirth}</div></div>
    <div class="stat"><div class="stat-label">Current Credits</div><div class="stat-value">${fmtNum(stats.currentCredits)}</div></div>
    <div class="stat"><div class="stat-label">Offline Earnings</div><div class="stat-value">${fmtNum(stats.offlineEarningsBhr, 3)}<span style="font-size:14px;color:var(--muted)"> b/hr</span></div></div>
  </div>

  <div class="stats-rate">
    <div class="stat"><div class="stat-label">Earning Rate</div><div class="stat-value">${fmtNum(ratePerMin, 2)}<span style="font-size:14px;color:var(--muted)"> cr/min</span></div></div>
    <div class="stat"><div class="stat-label">Cumulative Nova (proj. to end)</div><div class="stat-value">${fmtNum(nowNova)}</div></div>
  </div>

  <div class="results-head" style="margin-top:18px;">
    <div class="label">Upcoming rebirths — requirements, ETA &amp; Nova</div>
    <div class="tag">from Rebirth ${stats.currentRebirth}</div>
  </div>
  <div style="overflow-x:auto;">
    <table class="stats-table">
      <thead>
        <tr><th>Rebirth</th><th>Credits Req.</th><th>Rate (cr/min)</th><th>ETC (days)</th><th>ETC (hrs)</th><th>Nova</th></tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="6" class="empty">No upcoming rebirths in the cost table.</td></tr>'}</tbody>
    </table>
  </div>
  <p class="hint" style="margin-top:12px;">
    ETC = Credits Required ÷ Rate ÷ 1440 (days) / 60 (hours). Nova is the cumulative reward per the
    spreadsheet's reward curve (base 56). Rate is derived from Offline Earnings (b/hr → cr/min).
  </p>`;
}

module.exports = {
  MINUTES_PER_DAY,
  NOVA_BASE,
  decomposeHMS,
  etaToTarget,
  bhrToCreditsPerMin,
  cumulativeNovaCurve,
  buildDashboard,
  fmtNum,
  renderStatsView,
};
