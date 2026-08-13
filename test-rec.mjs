import { readFileSync } from 'fs';
import { readPricingWorkbook, parseMaterialsSheet, parseSummaryCostSheet, reconcileCommercials } from './src/shared/parse-xlsx.ts';

// Quick stub - just inline the logic since we can't easily import .ts from node
import * as XLSX from 'xlsx';

const buf = readFileSync('/Users/thomasbarber/Library/CloudStorage/OneDrive-PowerGridProjectsLtd/4. Sales Build/Active/MCR Property/MCR009 Block C Roofing/4. Pricing Documents/MCR009 Dallas Rd Block C Roofing Rev 1 .xlsx');
const wb = XLSX.read(new Uint8Array(buf).buffer, { type: 'array', sheets: ['Materials','Summary Cost Sheet'] });

// Parse materials cost/labour totals
const matRows = XLSX.utils.sheet_to_json(wb.Sheets['Materials'], { header:'A', defval:null, raw:true });
let measuredCost = 0;
for (let i = 4; i < matRows.length; i++) {
  const r = matRows[i];
  if (!r.A || r.B == null) continue;
  measuredCost += (Number(r.Y) || 0) + (Number(r.Z) || 0);
}
console.log('Materials sheet → measured cost:', measuredCost.toFixed(2));

// Parse Summary Cost Sheet
const sumRows = XLSX.utils.sheet_to_json(wb.Sheets['Summary Cost Sheet'], { header:'A', defval:null, raw:true });
// Find header row
let hi = -1, labelCol='E', valueCol='G', costCol='H', gpCol='I', gpPctCol='J';
for (let i = 0; i < 15; i++) {
  const entries = Object.entries(sumRows[i] || {});
  const ve = entries.find(([,v]) => typeof v==='string' && v.toLowerCase().trim()==='value');
  const gpe = entries.find(([,v]) => typeof v==='string' && /^gp$/i.test(String(v).trim()));
  if (ve && gpe) { hi=i; valueCol=ve[0]; gpCol=gpe[0]; const cols='ABCDEFGHIJKLMNOPQRSTUVWXYZ'; const vi=cols.indexOf(valueCol); costCol=cols[vi+1]; gpPctCol=cols[vi+3]; labelCol=cols[Math.max(0,vi-2)]; break; }
}
const parsed = [];
let order = 0;
for (let i = hi+1; i < sumRows.length; i++) {
  const r = sumRows[i];
  const label = r[labelCol]?.toString().trim();
  if (!label) continue;
  const value = Number(r[valueCol]), cost = Number(r[costCol]);
  if (isNaN(value) && isNaN(cost)) continue;
  parsed.push({ category: label, value: isNaN(value)?null:value, cost: isNaN(cost)?null:cost, gross_profit: Number(r[gpCol])||null, gross_profit_pct: Number(r[gpPctCol])||null, is_total: /^total$/i.test(label), display_order: order++ });
}

console.log('\nBefore reconcile:');
for (const r of parsed) console.log('  '+r.category.padEnd(22)+' value='+(r.value??'-').toString().padStart(12)+' cost='+(r.cost??'-').toString().padStart(12)+' gp='+(r.gross_profit??'-').toString().padStart(10)+' '+((r.gross_profit_pct??0)*100).toFixed(1)+'%');

// Reconcile manually
const out = parsed.map(r => ({...r}));
const measuredIdxs = out.map((r,i)=>({r,i})).filter(x=>/^\s*measured\s*works\s*$/i.test(x.r.category)).map(x=>x.i);
const innerIdx = measuredIdxs[measuredIdxs.length-1];
const parentIdx = measuredIdxs.length>=2 ? measuredIdxs[0] : -1;
const inner = out[innerIdx];
const tol = Math.max(50, measuredCost*0.005);
if (Math.abs((inner.cost??0)-measuredCost)>tol) {
  inner.cost = measuredCost;
  inner.gross_profit = (inner.value??0) - measuredCost;
  inner.gross_profit_pct = inner.value > 0 ? inner.gross_profit/inner.value : 0;
}
if (parentIdx >= 0) {
  const ancilIdx = out.findIndex(r=>/^\s*ancil/i.test(r.category));
  const ancilCost = ancilIdx>=0 ? (out[ancilIdx].cost??0) : 0;
  const parent = out[parentIdx];
  parent.cost = (inner.cost??0) + ancilCost;
  parent.gross_profit = (parent.value??0) - parent.cost;
  parent.gross_profit_pct = parent.value>0 ? parent.gross_profit/parent.value : 0;
}
const totalIdx = out.findIndex(r=>r.is_total);
if (totalIdx>=0) {
  const prelimsIdx = out.findIndex(r=>/^\s*prelim/i.test(r.category));
  const directorsIdx = out.findIndex(r=>/director/i.test(r.category));
  const measuredTopCost = parentIdx>=0 ? (out[parentIdx].cost??0) : (inner.cost??0);
  const prelimsCost = prelimsIdx>=0 ? (out[prelimsIdx].cost??0) : 0;
  const directorsCost = directorsIdx>=0 ? (out[directorsIdx].cost??0) : 0;
  const t = out[totalIdx];
  t.cost = prelimsCost + measuredTopCost + directorsCost;
  t.gross_profit = (t.value??0) - t.cost;
  t.gross_profit_pct = t.value>0 ? t.gross_profit/t.value : 0;
}

console.log('\nAfter reconcile:');
for (const r of out) console.log('  '+r.category.padEnd(22)+' value='+(r.value??'-').toString().padStart(12)+' cost='+(r.cost??'-').toString().padStart(12)+' gp='+(r.gross_profit??'-').toFixed(2).padStart(10)+' '+((r.gross_profit_pct??0)*100).toFixed(1)+'%');
