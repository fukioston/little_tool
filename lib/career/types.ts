export type CareerView =
  | "today"
  | "board"
  | "jobs"
  | "calendar"
  | "interviews"
  | "contacts"
  | "materials"
  | "analytics"
  | "settings";

export type Stage = {
  id: string;
  name: string;
  color: string;
  position: number;
  is_terminal: number;
  hidden: number;
};

export type Job = {
  id: string;
  company: string;
  role: string;
  location: string;
  source: string;
  source_url: string;
  stage_id: string;
  priority: number;
  salary: string;
  work_mode: string;
  description: string;
  applied_at: string | null;
  deadline: string | null;
  contact_name: string;
  note: string;
  tags: string;
  created_at: string;
  updated_at: string;
  archived: number;
  position: number;
  archived_at: string | null;
  ended_at: string | null;
  archived_operation_id: string | null;
  ended_operation_id: string | null;
};

export type CareerTaskStatus = "todo" | "done" | "canceled";

export type Task = {
  id: string;
  job_id: string | null;
  contact_id: string | null;
  title: string;
  due_at: string | null;
  kind: string;
  priority: number;
  status: CareerTaskStatus;
  created_at: string;
  updated_at: string | null;
  canceled_at: string | null;
  cancellation_reason: string | null;
  lifecycle_previous_status: "todo" | null;
  lifecycle_operation_id: string | null;
};

export type InterviewQuestion = {
  question: string;
  answer: string;
  note: string;
};

export type CareerInterviewStatus = "scheduled" | "completed" | "canceled";

export type Interview = {
  id: string;
  job_id: string;
  round_name: string;
  interview_type: string;
  scheduled_at: string | null;
  duration: number;
  interviewer: string;
  meeting_url: string;
  status: CareerInterviewStatus;
  summary: string;
  raw_notes: string;
  questions_json: string;
  reflection: string;
  created_at: string;
  updated_at: string;
  canceled_at: string | null;
  cancellation_reason: string | null;
  lifecycle_previous_status: "scheduled" | null;
  lifecycle_operation_id: string | null;
};

export type Contact = {
  id: string;
  company: string;
  name: string;
  role: string;
  channel: string;
  email: string;
  phone: string;
  last_contact_at: string | null;
  next_follow_up: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  archived: number;
};

export type ContactJobAssociation = {
  contact_id: string;
  job_id: string;
  created_at: string;
};

export type ContactInteraction = {
  id: string;
  contact_id: string;
  job_id: string | null;
  interaction_type: string;
  direction: "outbound" | "inbound" | "mutual";
  channel: string;
  summary: string;
  notes: string;
  occurred_at: string;
  created_at: string;
};

export type CareerContactDetail = {
  contact: Contact;
  associations: ContactJobAssociation[];
  jobs: Job[];
  interactions: ContactInteraction[];
  tasks: Task[];
};

export type Material = {
  id: string;
  name: string;
  kind: string;
  version: string;
  updated_at: string;
  linked_job_id: string | null;
  status: string;
  notes: string;
  file_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
};

export type Activity = {
  id: string;
  job_id: string | null;
  type: string;
  detail: string;
  created_at: string;
};

export type CareerData = {
  stages: Stage[];
  jobs: Job[];
  tasks: Task[];
  interviews: Interview[];
  contacts: Contact[];
  materials: Material[];
  activities: Activity[];
};

export type Notice = {
  id: string;
  tone: "success" | "error" | "info";
  text: string;
};

export type AiAction =
  | "fit_analysis"
  | "interview_prep"
  | "structure_interview";
