import { z } from "zod";
import type { AnswerResult } from "./evidence";
import { ProposalInput } from "./wiki";

export const DraftContent = z
  .object({
    title: ProposalInput.shape.title,
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(4000),
            evidenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const DraftEdit = DraftContent.extend({
  revision: z.number().int().positive(),
});
export type WritingDraft = z.infer<typeof DraftContent> & {
  id: string;
  revision: number;
  answer: AnswerResult;
  createdBy: string;
  updatedAt: number;
};
export type DraftListItem = Pick<
  WritingDraft,
  "id" | "title" | "revision" | "updatedAt"
>;
