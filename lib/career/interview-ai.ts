export type InterviewQuestionDraft = {
  question: string;
  answer: string;
  note: string;
};

export type StructuredInterviewDraft = {
  summary: string | null;
  questions: InterviewQuestionDraft[] | null;
  reflection: string | null;
};

type CurrentInterviewDraft = {
  rawNotes: string;
  questions: InterviewQuestionDraft[];
};

function optionalText(value: unknown, field: string, limit: number) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`AI 返回的 ${field} 格式不正确`);
  return value.trim().slice(0, limit);
}

function textList(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`AI 返回的 ${field} 格式不正确`);
  }
  return value.slice(0, 12).flatMap((item) => {
    const text = item.trim().slice(0, 2_000);
    return text ? [text] : [];
  });
}

export function createStructuredInterviewDraft(
  result: unknown,
  current: CurrentInterviewDraft,
): StructuredInterviewDraft {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("AI 没有返回可填入的结构，请保留原笔记并手动整理");
  }
  const record = result as Record<string, unknown>;
  const summary = optionalText(record.summary, "summary", 4_000);
  const rawQuestions = record.questions;
  if (rawQuestions !== undefined && !Array.isArray(rawQuestions)) {
    throw new Error("AI 返回的 questions 格式不正确");
  }
  const proposedQuestions = (rawQuestions ?? []).slice(0, 20).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`AI 返回的第 ${index + 1} 个问题格式不正确`);
    }
    const question = item as Record<string, unknown>;
    const title = optionalText(question.question, `questions[${index}].question`, 2_000);
    if (!title) throw new Error(`AI 返回的第 ${index + 1} 个问题缺少题目`);
    const existing = current.questions[index];
    const myAnswer = optionalText(question.my_answer, `questions[${index}].my_answer`, 4_000);
    const followUp = optionalText(question.interviewer_follow_up, `questions[${index}].interviewer_follow_up`, 2_000);
    const betterAnswer = optionalText(question.better_answer, `questions[${index}].better_answer`, 4_000);
    const answerIsGrounded = myAnswer.length >= 4 && current.rawNotes.includes(myAnswer);
    return {
      question: title,
      answer: existing?.answer || (answerIsGrounded ? myAnswer : ""),
      note: [
        existing?.note,
        followUp && `AI 识别的追问（待确认）：${followUp}`,
        betterAnswer && `AI 改进建议：${betterAnswer}`,
        myAnswer && !existing?.answer && !answerIsGrounded && `AI 整理的回答候选（待确认）：${myAnswer}`,
      ].filter(Boolean).join("\n"),
    };
  });
  const mergedQuestions = proposedQuestions.length > 0
    ? [...proposedQuestions, ...current.questions.slice(proposedQuestions.length).map((question) => ({ ...question }))]
    : [];
  const reflectionSections = [
    ["做得好的地方（AI 整理，待确认）", textList(record, "strengths")],
    ["可以改进（AI 建议）", textList(record, "improvements")],
    ["下一步（AI 建议）", textList(record, "next_steps")],
    ["仍需确认", textList(record, "uncertain_items")],
  ].flatMap(([title, items]) => {
    const values = items as string[];
    return values.length > 0 ? [`${title}\n${values.map((item) => `• ${item}`).join("\n")}`] : [];
  });
  const reflection = reflectionSections.join("\n\n");
  if (!summary && mergedQuestions.length === 0 && !reflection) {
    throw new Error("AI 返回的字段不完整，当前面经草稿没有被改动");
  }
  return {
    summary: summary || null,
    questions: mergedQuestions.length > 0 ? mergedQuestions : null,
    reflection: reflection || null,
  };
}
