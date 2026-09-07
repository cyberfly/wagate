export interface AIRequest {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}
export interface AIProvider {
  generate(request: AIRequest): Promise<string>;
}
