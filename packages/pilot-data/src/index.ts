export {
  AIML_SEMESTER_V,
  DEPARTMENTS,
  FIRST_NAMES,
  INSTITUTION,
  PILOT_COURSE,
  PROGRAMMES,
  TERM,
} from './catalogue.js';
export type { CatalogueCourse } from './catalogue.js';
export { SCENARIOS } from './scenarios.js';
export type { Scenario } from './scenarios.js';
export { seeded } from './random.js';
export type { Random } from './random.js';
export {
  DEFAULT_OPTIONS,
  SECTION_KEYS,
  generatePilotData,
  summarizePilotData,
} from './generate.js';
export type {
  PilotAssessment,
  PilotData,
  PilotOffering,
  PilotOptions,
  PilotPaperViewing,
  PilotStaff,
  PilotStudent,
  PilotSummary,
  PilotTranscript,
  SectionKey,
} from './generate.js';
