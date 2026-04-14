export type FieldType = "text" | "textarea" | "select" | "radio" | "checkbox" | "file";

export type FormField = {
  selector: string;     
  label: string;        
  type: FieldType;
  required: boolean;
  options?: string[];   
  name?: string;        
};

export type AnswerMap = Record<string, string>;

export type ConfidenceTier = "high" | "medium" | "low" | "none";

export type MappedField = {
  field: FormField;
  value: string | null;
  confidence: ConfidenceTier;
};
