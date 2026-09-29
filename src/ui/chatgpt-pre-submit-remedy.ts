export function chatGptPreSubmitRemedy(code: string | null): string | null {
  if (code === "CHATGPT_APP_SELECTION_MISSING") {
    return "Farol could not select the app chosen in Setup. Nothing was sent. Check its exact name and availability in ChatGPT before running the check again.";
  }
  if (code === "CHATGPT_APP_SELECTION_AMBIGUOUS") {
    return "Message blocked before send because the app selection was ambiguous. Keep exactly one chip for the app chosen in Setup before trying again.";
  }
  if (code === "CHATGPT_APP_SELECTION_CONFLICT") {
    return "Message blocked before send because another app is selected. Remove it and select the app chosen in Setup; Farol did not switch apps automatically.";
  }
  if (code === "CHATGPT_APP_SELECTION_LOST") {
    return "The app chosen in Setup disappeared from the composer before send. Nothing was sent. Check the selection before trying again.";
  }
  if (code === "CHATGPT_COMPOSER_DRAFT_PRESENT") {
    return "Message blocked before send because the composer already had text. Your draft was preserved; finish or clear it, then retry.";
  }
  if (code === "CHATGPT_TEMPORARY_CHAT_REQUIRED") {
    return "Nothing was sent. Farol could not confirm a personalized temporary chat; your history and draft were left unchanged.";
  }
  if (code === "CHATGPT_INSTANT_MODEL_REQUIRED") {
    return "Nothing was sent. Farol could not confirm Instant as the selected model for this check.";
  }
  return null;
}
