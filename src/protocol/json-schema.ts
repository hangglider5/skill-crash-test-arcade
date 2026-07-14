import { z } from "zod";

import {
  DiagnosisSchema,
  FinalClaimSchema,
  SkillContractSchema
} from "./schema.js";

const options = { target: "draft-2020-12" as const };

export const SkillContractJsonSchema = z.toJSONSchema(SkillContractSchema, options);
export const FinalClaimJsonSchema = z.toJSONSchema(FinalClaimSchema, options);
export const DiagnosisJsonSchema = z.toJSONSchema(DiagnosisSchema, options);
