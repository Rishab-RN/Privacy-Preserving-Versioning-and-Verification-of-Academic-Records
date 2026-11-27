/**
 * Catalogue facts for the pilot. Course codes, titles and credits come from the public AIML
 * 2022-scheme syllabus (S1, PDF pp.7-8). The institution, people and marks are synthetic.
 */
export const INSTITUTION = {
  code: 'ARDC',
  name: 'Academic Records Demo College (synthetic, RVCE-inspired)',
} as const;

export const TERM = {
  code: '2026-27-ODD',
  label: 'AY 2026-27 odd semester',
  scheme: '2022',
  semester: 5,
  admissionYear: 2024,
} as const;

export const DEPARTMENTS = [
  { code: 'AI', name: 'Artificial Intelligence and Machine Learning' },
  { code: 'CD', name: 'Computer Science and Engineering (Data Science)' },
  { code: 'IS', name: 'Information Science and Engineering' },
] as const;

export const PROGRAMMES = [
  { code: 'BE-AI', department: 'AI', name: 'B.E. Artificial Intelligence and Machine Learning' },
  { code: 'BE-IS', department: 'IS', name: 'B.E. Information Science and Engineering' },
] as const;

export interface CatalogueCourse {
  readonly code: string;
  readonly title: string;
  readonly credits: string;
}

/** CD252IA: Professional Core, theory and practice, L:T:P 3:0:1, owned by the CD board (S1 p.7, p.13). */
export const PILOT_COURSE = {
  code: 'CD252IA',
  title: 'Database Management Systems',
  credits: '4',
  ltp: '3:0:1',
  board: 'CD',
} as const;

/** AIML Semester V scheme of teaching, 20 credits (S1 PDF p.7; electives from p.8). */
export const AIML_SEMESTER_V: readonly CatalogueCourse[] = [
  { code: 'HS251TA', title: 'Principles of Management and Economics', credits: '3' },
  { code: 'CD252IA', title: 'Database Management Systems', credits: '4' },
  { code: 'AI253IA', title: 'Artificial Neural Networks and Deep Learning', credits: '4' },
  { code: 'AI254TA', title: 'Machine Learning Operations', credits: '4' },
  {
    code: 'AI255TBA',
    title: 'Artificial Intelligence Integrated Software Engineering (Elective I)',
    credits: '3',
  },
  {
    code: 'AI256TCA',
    title: 'Information Security-5-Secure Systems Engineering (Elective II, NPTEL)',
    credits: '2',
  },
];

/** Common first names and an initial: generic enough not to describe any real person. */
export const FIRST_NAMES = [
  'Aarav',
  'Aditi',
  'Akash',
  'Ananya',
  'Arjun',
  'Asha',
  'Bhavana',
  'Chetan',
  'Deepa',
  'Divya',
  'Farhan',
  'Gaurav',
  'Gayathri',
  'Harini',
  'Imran',
  'Ishaan',
  'Kavya',
  'Kiran',
  'Lakshmi',
  'Manoj',
  'Meera',
  'Nikhil',
  'Nisha',
  'Pooja',
  'Pranav',
  'Priya',
  'Rahul',
  'Rohan',
  'Sahana',
  'Sanjay',
  'Shreya',
  'Sneha',
  'Tanvi',
  'Varun',
  'Vidya',
  'Vikram',
  'Yash',
  'Zoya',
] as const;
