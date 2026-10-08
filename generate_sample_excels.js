const XLSX = require('xlsx');

const inputRows = [
  {
    PromptID: 'P1',
    Prompt: 'What is AI?',
    'Groundedness Truth': 'AI is the simulation of human intelligence by machines.'
  },
  {
    PromptID: 'P2',
    Prompt: 'What is machine learning?',
    'Groundedness Truth': 'Machine learning is a method where models learn patterns from data.'
  }
];

const inputWb = XLSX.utils.book_new();
const inputSheet = XLSX.utils.json_to_sheet(inputRows);
XLSX.utils.book_append_sheet(inputWb, inputSheet, 'Sheet1');
XLSX.writeFile(inputWb, 'sample-input.xlsx');

const outputRows = [
  {
    PromptID: 'P1',
    Prompt: 'What is AI?',
    'Groundedness Truth': 'AI is the simulation of human intelligence by machines.',
    Accuracy: 90,
    Groundedness: 88,
    Completeness: 85,
    'Clarity & Structure': 92,
    'Handling Ambiguity': 80,
    'Hallucination Resistance': 87,
    'Formatting / Fidelity': 90,
    'Overall Score': 87.5,
    Pass: 'PASS',
    'Pass Threshold': 70
  },
  {
    PromptID: 'P2',
    Prompt: 'What is machine learning?',
    'Groundedness Truth': 'Machine learning is a method where models learn patterns from data.',
    Accuracy: 82,
    Groundedness: 84,
    Completeness: 80,
    'Clarity & Structure': 88,
    'Handling Ambiguity': 76,
    'Hallucination Resistance': 85,
    'Formatting / Fidelity': 86,
    'Overall Score': 82.8,
    Pass: 'PASS',
    'Pass Threshold': 70
  }
];

const outputWb = XLSX.utils.book_new();
const outputSheet = XLSX.utils.json_to_sheet(outputRows);
XLSX.utils.book_append_sheet(outputWb, outputSheet, 'Evaluation Results');

const statsSheet = XLSX.utils.json_to_sheet([
  { Metric: 'Total Prompts', Value: 2 },
  { Metric: 'Pass Count', Value: 2 },
  { Metric: 'Fail Count', Value: 0 },
  { Metric: 'Pass Rate (%)', Value: 100 },
  { Metric: 'Average Overall Score', Value: 85.15 }
]);
XLSX.utils.book_append_sheet(outputWb, statsSheet, 'Charts & Stats');
XLSX.writeFile(outputWb, 'sample-output.xlsx');

console.log('Created sample-input.xlsx and sample-output.xlsx');
