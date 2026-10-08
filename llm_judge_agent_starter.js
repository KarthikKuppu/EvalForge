#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function loadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Could not read ${filePath}: ${err.message}`);
    process.exit(1);
  }
}

function normalizeCriteria(criteria = []) {
  return criteria
    .map((criterion) => ({
      name: String(criterion.name || '').trim(),
      weight: Number(criterion.weight || 0),
    }))
    .filter((criterion) => criterion.name && Number.isFinite(criterion.weight) && criterion.weight > 0);
}

function buildCriterionSummary(criteria) {
  return criteria.map((criterion) => `- ${criterion.name}: ${criterion.weight}%`).join('\n');
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/%/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function computeWeightedScore(criterionScores, criteria) {
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const criterion of criteria) {
    const score = Number(criterionScores[criterion.name] ?? 0);
    weightedTotal += (score / 100) * criterion.weight;
    totalWeight += criterion.weight;
  }

  if (totalWeight === 0) return 0;
  return Number(((weightedTotal / totalWeight) * 100).toFixed(2));
}

function normalizeExcelHeaders(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row || {})) {
    const cleanKey = String(key).trim();
    normalized[cleanKey] = value;
  }
  return normalized;
}

function readExcelRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
  return rows.map((row) => normalizeExcelHeaders(row));
}

function getDefaultCriteria() {
  return [
    { name: 'Accuracy', weight: 25 },
    { name: 'Groundedness', weight: 20 },
    { name: 'Completeness', weight: 20 },
    { name: 'Clarity & Structure', weight: 10 },
    { name: 'Handling Ambiguity', weight: 10 },
    { name: 'Hallucination Resistance', weight: 10 },
    { name: 'Formatting / Fidelity', weight: 5 },
  ];
}

function getPassThresholdFromInstruction(instructionsText) {
  const match = instructionsText.match(/pass threshold of\s+(\d+(?:\.\d+)?)/i) || instructionsText.match(/pass threshold\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : 70;
}

async function callModel(messages) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;

  if (endpoint) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-01';

    if (!deployment || !apiKey) {
      throw new Error('AZURE_OPENAI_DEPLOYMENT and AZURE_OPENAI_API_KEY are required.');
    }

    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Azure OpenAI request failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('Set OPENAI_API_KEY or AZURE_OPENAI_ENDPOINT');
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI request failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

function buildJudgePrompt({ row, criteria, judgeInstructions }) {
  const criterionSummary = buildCriterionSummary(criteria);
  const promptText = row.Prompt || row['Prompt Text'] || row.prompt || '';
  const candidateAnswer = row['Model Output'] || row.Answer || row['Candidate Answer'] || row.Output || row.response || row.Prompt || row['Prompt Text'] || row.prompt || 'No model output provided.';
  const groundednessTruth = row['Groundedness Truth'] || row['GroundednessTruth'] || row['Groundedness truth'] || '';
  const defaultThreshold = getPassThresholdFromInstruction(judgeInstructions);

  return `${judgeInstructions}

## Evaluation input

### Criteria and weights
${criterionSummary}

### Global pass threshold
${defaultThreshold}

### Prompt
${promptText}

### Groundedness Truth
${groundednessTruth || 'No Groundedness Truth provided.'}

### Candidate answer
${candidateAnswer}

### Additional validation hint
- Use the provided Groundedness Truth as the expected grounded result when it has values.
- If it is blank, judge only on the information available.
- Return valid JSON matching the schema exactly.`;
}

async function evaluateSingleRow({ row, criteria, judgeInstructions, passThreshold }) {
  const messages = [
    { role: 'system', content: 'You are a strict evaluator. Return only valid JSON.' },
    { role: 'user', content: buildJudgePrompt({ row, criteria, judgeInstructions }) },
  ];

  const raw = await callModel(messages);
  const parsed = JSON.parse(raw);

  const criterionScores = {};
  for (const criterion of criteria) {
    const key = criterion.name;
    const value = parsed.criterion_scores?.[key];
    criterionScores[key] = Number(value ?? 0);
  }

  const overallScore = computeWeightedScore(criterionScores, criteria);
  const pass = overallScore >= Number(passThreshold || 70);

  return {
    ...parsed,
    criterion_scores: criterionScores,
    overall_score: overallScore,
    pass,
  };
}

function handleJsonInput(filePath, judgeInstructions) {
  const payload = loadJson(filePath);
  const criteria = normalizeCriteria(payload.criteria || payload.rubric || getDefaultCriteria());
  const passThreshold = Number(payload.passThreshold || getPassThresholdFromInstruction(judgeInstructions));
  const tasks = Array.isArray(payload.batch) ? payload.batch : [payload];

  return { criteria, passThreshold, tasks };
}

function handleExcelInput(filePath, judgeInstructions) {
  const rows = readExcelRows(filePath);
  const criteria = getDefaultCriteria();
  const passThreshold = getPassThresholdFromInstruction(judgeInstructions);

  const normalizedRows = rows.map((row) => {
    const normalized = {};
    for (const key of Object.keys(row)) {
      normalized[key.trim()] = row[key];
    }

    const criterionScores = {};
    let hasExplicitRubricData = false;
    for (const criterion of criteria) {
      const scoreValue = normalized[criterion.name] ?? normalized[criterion.name.trim()] ?? normalized[criterion.name.toLowerCase()];
      const numericValue = parseNumber(scoreValue);
      criterionScores[criterion.name] = numericValue;
      if (scoreValue !== undefined && scoreValue !== null && scoreValue !== '') {
        hasExplicitRubricData = true;
      }
    }

    const rawScore = Object.values(criterionScores).reduce((sum, value) => sum + value, 0);
    const overallScore = hasExplicitRubricData ? Number((rawScore / Math.max(criteria.length, 1)).toFixed(2)) : 0;

    return {
      ...normalized,
      PromptID: normalized.PromptID || normalized['Prompt ID'] || normalized.id || '',
      Prompt: normalized.Prompt || normalized['Prompt Text'] || normalized.prompt || '',
      Model: normalized.Model || normalized.model || '',
      Accuracy: criterionScores.Accuracy,
      Groundedness: criterionScores.Groundedness,
      Completeness: criterionScores.Completeness,
      'Clarity & Structure': criterionScores['Clarity & Structure'],
      'Handling Ambiguity': criterionScores['Handling Ambiguity'],
      'Hallucination Resistance': criterionScores['Hallucination Resistance'],
      'Formatting / Fidelity': criterionScores['Formatting / Fidelity'],
      GroundednessTruth: normalized['Groundedness Truth'] || normalized['GroundednessTruth'] || normalized['Groundedness truth'] || '',
      OverallScore: overallScore,
      Pass: overallScore >= passThreshold,
      passThreshold,
      hasExplicitRubricData,
    };
  });

  return { criteria, passThreshold, tasks: normalizedRows };
}

function getDefaultInputPath() {
  const candidates = ['input.xlsx', 'input.json', 'input.csv'];
  for (const candidate of candidates) {
    const filePath = path.join(__dirname, candidate);
    if (fs.existsSync(filePath)) return filePath;
  }
  return path.join(__dirname, 'input.xlsx');
}

function buildOutputWorkbook({ inputFilePath, results, criteria, passThreshold, sourceRows }) {
  const workbook = XLSX.utils.book_new();

  const outputRows = sourceRows.map((row, index) => {
    const resultMap = results.find((r) => String(r.PromptID || r.id || '') === String(row.PromptID || row.id || '')) || results[index] || {};
    const rowScores = resultMap.criterion_scores || {};
    const out = { ...row };

    out['PromptID'] = row.PromptID || row['Prompt ID'] || row.id || index + 1;
    out['Prompt'] = row.Prompt || row['Prompt Text'] || row.prompt || '';
    out['Model'] = row.Model || row.model || 'LLM Judge';
    out['Accuracy'] = rowScores.Accuracy ?? row.Accuracy ?? 0;
    out['Groundedness'] = rowScores.Groundedness ?? row.Groundedness ?? 0;
    out['Completeness'] = rowScores.Completeness ?? row.Completeness ?? 0;
    out['Clarity & Structure'] = rowScores['Clarity & Structure'] ?? row['Clarity & Structure'] ?? 0;
    out['Handling Ambiguity'] = rowScores['Handling Ambiguity'] ?? row['Handling Ambiguity'] ?? 0;
    out['Hallucination Resistance'] = rowScores['Hallucination Resistance'] ?? row['Hallucination Resistance'] ?? 0;
    out['Formatting / Fidelity'] = rowScores['Formatting / Fidelity'] ?? row['Formatting / Fidelity'] ?? 0;
    out['Groundedness Truth'] = row['Groundedness Truth'] || row['GroundednessTruth'] || row['Groundedness truth'] || '';
    out['Overall Score'] = Number(resultMap.overall_score ?? row.OverallScore ?? 0);
    out['Pass'] = Boolean(resultMap.pass ?? row.Pass ?? false);
    out['Pass Threshold'] = Number(passThreshold || 70);
    out['Weighted Score Formula'] = row['Weighted Score Formula'] || '(Accuracy*25 + Groundedness*20 + Completeness*20 + Clarity*10 + Ambiguity*10 + Hallucination*10 + Formatting*5) / 100';
    return out;
  });

  const evaluationSheet = XLSX.utils.json_to_sheet(outputRows);
  XLSX.utils.book_append_sheet(workbook, evaluationSheet, 'Evaluation Results');

  const summaryRows = results.map((result) => {
    const rowId = result.PromptID || result.id || 'N/A';
    const overall = Number(result.overall_score ?? 0);
    return {
      'Prompt ID': rowId,
      'Overall Score': overall,
      'Pass': result.pass ? 'PASS' : 'FAIL',
      'Pass Threshold': Number(passThreshold || 70),
      'Model': result.Model || '',
      'Notes': result.weighted_summary || '',
    };
  });

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Batch Summary');

  const criterionAverages = criteria.map((criterion) => {
    const values = results.map((result) => Number((result.criterion_scores && result.criterion_scores[criterion.name]) || 0));
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    return { Criterion: criterion.name, Average: Number(average.toFixed(2)) };
  });

  const statsRows = [
    { Metric: 'Total Prompts', Value: results.length },
    { Metric: 'Pass Count', Value: results.filter((r) => r.pass).length },
    { Metric: 'Fail Count', Value: results.filter((r) => !r.pass).length },
    { Metric: 'Pass Rate (%)', Value: results.length ? Number(((results.filter((r) => r.pass).length / results.length) * 100).toFixed(2)) : 0 },
    { Metric: 'Average Overall Score', Value: results.length ? Number((results.reduce((sum, r) => sum + Number(r.overall_score || 0), 0) / results.length).toFixed(2)) : 0 },
  ];

  const statsSheet = XLSX.utils.json_to_sheet(statsRows);
  XLSX.utils.book_append_sheet(workbook, statsSheet, 'Charts & Stats');

  const chartStartRow = 2;
  const chartStartCol = 0;
  const statsHeaders = ['Metric', 'Value'];
  const statCells = statsSheet['!ref'] ? XLSX.utils.decode_range(statsSheet['!ref']) : { s: { c: 0, r: 0 }, e: { c: 1, r: statsRows.length + 1 } };
  const sheetRange = XLSX.utils.decode_range(statsSheet['!ref']);
  for (let c = 0; c < 2; c++) {
    const headerCell = statsSheet[XLSX.utils.encode_cell({ r: 0, c })];
    if (headerCell) {
      headerCell.s = { fill: { fgColor: { rgb: 'D9EAF7' }, patternType: 'solid' }, font: { bold: true } };
    }
  }

  for (let i = 0; i < criterionAverages.length; i++) {
    const row = 2 + i;
    const nameCell = statsSheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
    const valueCell = statsSheet[XLSX.utils.encode_cell({ r: row, c: 1 })];
    if (!nameCell) {
      statsSheet[XLSX.utils.encode_cell({ r: row, c: 0 })] = { t: 's', v: criterionAverages[i].Criterion };
    }
    if (!valueCell) {
      statsSheet[XLSX.utils.encode_cell({ r: row, c: 1 })] = { t: 'n', v: criterionAverages[i].Average };
    }
  }

  const comparisonStartRow = 2;
  const barData = [
    { Label: 'Average Overall', Value: statsRows[4].Value },
    { Label: 'Pass Rate %', Value: statsRows[3].Value },
  ];

  const graphicRows = [
    { Metric: 'Overall Avg', Bar: '' },
    { Metric: 'Pass Rate', Bar: '' },
  ];

  const barCol = 3;
  const startRow = 2;
  for (let i = 0; i < barData.length; i++) {
    const row = startRow + i;
    const labelCell = statsSheet[XLSX.utils.encode_cell({ r: row, c: 0 })];
    const valueCell = statsSheet[XLSX.utils.encode_cell({ r: row, c: 1 })];
    const barCell = XLSX.utils.encode_cell({ r: row, c: barCol });
    statsSheet[barCell] = { t: 's', v: '█'.repeat(Math.max(1, Math.min(20, Math.round(barData[i].Value / 5)))) };
    statsSheet[barCell].s = { font: { color: { rgb: i === 0 ? '2F7D32' : '1F4E79' }, bold: true } };
  }

  statsSheet['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 24 }, { wch: 20 }];

  const outputPath = path.join(path.dirname(inputFilePath), 'evaluation-output.xlsx');
  XLSX.writeFile(workbook, outputPath);
  console.log(`Evaluation workbook written to ${outputPath}`);
  return outputPath;
}

function buildHtmlReport({ results, criteria, passThreshold }) {
  const avgOverall = results.length ? (results.reduce((sum, result) => sum + Number(result.overall_score || 0), 0) / results.length).toFixed(2) : '0';
  const passRate = results.length ? ((results.filter((result) => result.pass).length / results.length) * 100).toFixed(2) : '0';

  const criterionValues = criteria.map((criterion) => {
    const values = results.map((result) => Number((result.criterion_scores && result.criterion_scores[criterion.name]) || 0));
    const average = values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
    return { name: criterion.name, score: average };
  });

  const maxScore = Math.max(100, ...criterionValues.map((entry) => entry.score), 100);
  const barMarkup = criterionValues.map((entry) => {
    const width = (entry.score / maxScore) * 100;
    return `
      <div class="metric-row">
        <div class="metric-label">${entry.name}</div>
        <div class="bar-track"><div class="bar-fill" style="width: ${width}%">${entry.score.toFixed(1)}</div></div>
      </div>`;
  }).join('');

  const html = `<!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>LLM Judge Batch Evaluation Report</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; background: #f5f7fb; color: #1a1a1a; }
      .container { max-width: 1100px; margin: 0 auto; }
      .card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 3px 10px rgba(0,0,0,0.08); margin-bottom: 22px; }
      .summary { display: flex; gap: 18px; flex-wrap: wrap; }
      .tile { flex: 1 1 180px; background: linear-gradient(135deg, #eef6ff, #eafaf2); border-radius: 10px; padding: 16px; }
      .tile h3 { margin: 0 0 8px; font-size: 14px; color: #495057; }
      .tile .value { font-size: 28px; font-weight: 700; }
      .metric-row { display: grid; grid-template-columns: 220px 1fr; gap: 12px; align-items: center; margin: 12px 0; }
      .metric-label { font-size: 13px; }
      .bar-track { background: #e9ecef; border-radius: 999px; overflow: hidden; height: 18px; }
      .bar-fill { display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; font-size: 11px; font-weight: 700; background: linear-gradient(90deg, #4f8ef7, #2a9d8f); color: white; height: 100%; }
      .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
      .svg-box { background: #fff; border: 1px solid #dde4ee; border-radius: 8px; padding: 8px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border: 1px solid #dfe3e8; padding: 8px 10px; text-align: left; }
      th { background: #eef4ff; }
      .pass { color: #1f8a4d; font-weight: 700; }
      .fail { color: #b42318; font-weight: 700; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h2>LLM Judge Batch Evaluation Report</h2>
        <div class="summary">
          <div class="tile"><h3>Average Overall Score</h3><div class="value">${avgOverall}</div></div>
          <div class="tile"><h3>Pass Rate</h3><div class="value">${passRate}%</div></div>
          <div class="tile"><h3>Pass Threshold</h3><div class="value">${passThreshold}</div></div>
          <div class="tile"><h3>Total Rows</h3><div class="value">${results.length}</div></div>
        </div>
      </div>

      <div class="card">
        <h3>Criterion Averages</h3>
        ${barMarkup}
      </div>

      <div class="card chart-grid">
        <div class="svg-box">
          <h3>Score Distribution</h3>
          <svg viewBox="0 0 420 220" width="100%" height="220" role="img" aria-label="Score distribution bar chart">
            <line x1="40" x2="360" y1="180" y2="180" stroke="#999" />
            ${criterionValues.map((entry, idx) => {
              const x = 60 + idx * 45;
              const barHeight = (entry.score / 100) * 120;
              const y = 180 - barHeight;
              return `
                <rect x="${x}" y="${y}" width="30" height="${barHeight}" fill="#4f8ef7" rx="4" />
                <text x="${x + 15}" y="195" text-anchor="middle" font-size="10">${entry.name.split(' ')[0]}</text>
                <text x="${x + 15}" y="${y - 8}" text-anchor="middle" font-size="10" fill="#333">${entry.score.toFixed(0)}</text>
              `;
            }).join('')}
          </svg>
        </div>
        <div class="svg-box">
          <h3>Pass/Fail Snapshot</h3>
          <svg viewBox="0 0 220 220" width="100%" height="220" role="img" aria-label="Pass fail chart">
            <circle cx="110" cy="110" r="70" fill="#eef2ff" stroke="#dfe7f5" stroke-width="2" />
            <circle cx="110" cy="110" r="70" fill="none" stroke="#1f8a4d" stroke-width="28" stroke-dasharray="${(results.filter((r) => r.pass).length / Math.max(results.length, 1)) * 440} 440" transform="rotate(-90 110 110)" />
            <circle cx="110" cy="110" r="70" fill="none" stroke="#d0d7df" stroke-width="28" stroke-dasharray="${((results.filter((r) => !r.pass).length / Math.max(results.length, 1)) * 440)} 440" transform="rotate(-90 110 110)" />
            <text x="110" y="105" text-anchor="middle" font-size="26" font-weight="700">${passRate}%</text>
            <text x="110" y="130" text-anchor="middle" font-size="12">Pass rate</text>
          </svg>
        </div>
      </div>

      <div class="card">
        <h3>Detailed Results</h3>
        <table>
          <thead>
            <tr>
              <th>Prompt ID</th>
              <th>Overall Score</th>
              <th>Pass</th>
              <th>Model</th>
            </tr>
          </thead>
          <tbody>
            ${results.map((result) => `
              <tr>
                <td>${result.PromptID || result.id || 'N/A'}</td>
                <td>${Number(result.overall_score || 0).toFixed(2)}</td>
                <td class="${result.pass ? 'pass' : 'fail'}">${result.pass ? 'PASS' : 'FAIL'}</td>
                <td>${result.Model || 'LLM Judge'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </body>
  </html>`;

  const reportPath = path.join(__dirname, 'evaluation-report.html');
  fs.writeFileSync(reportPath, html);
  console.log(`HTML evaluation report written to ${reportPath}`);
  return reportPath;
}

async function main() {
  const defaultInput = getDefaultInputPath();
  const inputArg = process.argv[2] || defaultInput;
  const judgeInstructionsFile = process.argv[3] || path.join(__dirname, 'judge-instructions.md');
  const judgeInstructions = loadText(judgeInstructionsFile);

  const fileExt = path.extname(inputArg).toLowerCase();
  const isExcel = ['.xlsx', '.xls', '.xlsm'].includes(fileExt);
  const isJson = fileExt === '.json';

  if (!isExcel && !isJson) {
    throw new Error('Input file must be a JSON or Excel spreadsheet (.json, .xlsx, .xls, .xlsm).');
  }

  const { criteria, passThreshold, tasks } = isJson ? handleJsonInput(inputArg, judgeInstructions) : handleExcelInput(inputArg, judgeInstructions);

  const results = [];

  for (const task of tasks) {
    if (isExcel && task.hasExplicitRubricData) {
      const rowScores = {
        Accuracy: Number(task.Accuracy || 0),
        Groundedness: Number(task.Groundedness || 0),
        Completeness: Number(task.Completeness || 0),
        'Clarity & Structure': Number(task['Clarity & Structure'] || 0),
        'Handling Ambiguity': Number(task['Handling Ambiguity'] || 0),
        'Hallucination Resistance': Number(task['Hallucination Resistance'] || 0),
        'Formatting / Fidelity': Number(task['Formatting / Fidelity'] || 0),
      };

      const overallScore = computeWeightedScore(rowScores, criteria);
      const pass = overallScore >= passThreshold;
      results.push({
        PromptID: task.PromptID || '',
        Prompt: task.Prompt || '',
        Model: task.Model || 'LLM Judge',
        criterion_scores: rowScores,
        overall_score: overallScore,
        pass,
        GroundednessTruth: task.GroundednessTruth || task['Groundedness Truth'] || '',
        weighted_summary: 'Batch evaluation result',
      });
      continue;
    }

    const evaluated = await evaluateSingleRow({ row: task, criteria, judgeInstructions, passThreshold });
    results.push({
      id: task.id || `item_${results.length + 1}`,
      PromptID: task.PromptID || task.id || `item_${results.length + 1}`,
      Prompt: task.Prompt || task['Prompt Text'] || task.prompt || '',
      Model: task.Model || task.model || 'LLM Judge',
      GroundednessTruth: task.GroundednessTruth || task['Groundedness Truth'] || task['GroundednessTruth'] || '',
      ...evaluated,
    });
  }

  const output = {
    passThreshold,
    criteria: criteria.map((criterion) => ({
      name: criterion.name,
      weight: criterion.weight,
    })),
    results,
  };

  const sourceRows = isJson ? tasks : readExcelRows(inputArg);
  const outputPath = buildOutputWorkbook({ inputFilePath: inputArg, results, criteria, passThreshold, sourceRows });
  buildHtmlReport({ results, criteria, passThreshold });

  console.log(JSON.stringify(output, null, 2));
  console.log(`Output Excel file: ${outputPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('LLM Judge Agent failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildJudgePrompt,
  computeWeightedScore,
  getDefaultCriteria,
  handleExcelInput,
  handleJsonInput,
  buildOutputWorkbook,
  buildHtmlReport,
  main,
};
