export function conversationNotes(artifactId: string): string[] {
  return [
    "Atlas payment terms are 30 days.",
    "The model base currency is USD. EUR is not the base currency.",
    "The discount rate assumption is 12%.",
    "The annual revenue assumption is USD 1,200,000.",
    "The cash-collection calculation uses a 360-day year.",
    "The exact source artifact identifier is " + artifactId + ".",
    "The gross margin assumption is 60%.",
    "The EBITDA margin assumption is 20%.",
    "The supplier churn rate has not been provided and remains unknown.",
    "Keep the Atlas assumptions available while we discuss an unrelated Orion project.",
    "The Orion project uses a blue cover. This does not change Atlas assumptions.",
    "The risk review is due tomorrow, relative to the timestamp of this message in UTC.",
    "An assistant suggestion is not an executed action.",
    "No supplier email has been sent or independently verified.",
    "Correction: Atlas payment terms are 45 days, replacing the earlier 30 days.",
    "Atlas financial assumptions are user-supplied inputs and have not been independently verified.",
    "The Orion project has a separate draft, with no shared revenue assumption.",
    "Keep the source artifact identifier exactly as given.",
    ...Array.from({ length: 12 }, (_, index) => "Discussion note " + (index + 19) + ": the current Atlas analysis remains a draft."),
  ];
}
