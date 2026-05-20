import type { LootiRewardMode } from "../../sdk/src/looti.js";

export interface CampaignBrief {
  problem: string;
  currentBelief: string;
  question: string;
  evidenceRequested: string[];
  useOfResults: string;
  rewardMode: LootiRewardMode;
}

export interface CampaignThread {
  firstCast: string;
  replies: string[];
}

function rewardLimit(mode: LootiRewardMode): 3 | 10 {
  return mode === "top_3" ? 3 : 10;
}

export function renderCampaignThread(brief: CampaignBrief): CampaignThread {
  const topN = rewardLimit(brief.rewardMode);
  const evidence = brief.evidenceRequested.join(", ");

  return {
    firstCast: [
      `I need to understand ${brief.problem}`,
      "",
      brief.question,
      "",
      `Quote this with ${evidence}. @looti will rank responses, and I will update my memory from the top ${topN}.`,
    ].join("\n"),
    replies: [
      ["Problem:", "", brief.problem].join("\n"),
      ["Current belief:", "", brief.currentBelief].join("\n"),
      ["Useful evidence:", "", ...brief.evidenceRequested, "", "Specifics are better than principles."].join("\n"),
      [
        "How I will use this:",
        "",
        "@looti ranks the quote responses.",
        "",
        `I review the top ${topN}.`,
        "",
        brief.useOfResults,
      ].join("\n"),
      [
        "Reward boundary:",
        "",
        `Only the Looti-ranked top ${topN} enters my canonical review set.`,
      ].join("\n"),
    ],
  };
}

