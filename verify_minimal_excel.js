const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { handleExcelInput } = require('./llm_judge_agent_starter.js');

const file = path.join(process.cwd(), 'tmp_minimal_input.xlsx');
const ws = XLSX.utils.json_to_sheet([
  {
    PromptID: 'P1',
    Prompt: 'What is AI?',
    'Groundedness Truth': 'AI is the simulation of human intelligence by machines.'
  }
]);

XLSX.writeFile({ Sheets: { Sheet1: ws }, SheetNames: ['Sheet1'] }, file);
const result = handleExcelInput(file, 'Use a pass threshold of 70.');
console.log('PromptID:', result.tasks[0].PromptID);
console.log('Prompt:', result.tasks[0].Prompt);
console.log('GroundednessTruth:', result.tasks[0].GroundednessTruth);
fs.unlinkSync(file);
