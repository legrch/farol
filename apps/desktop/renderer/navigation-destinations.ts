/** Every renderer navigation surface has an explicit rendered home. */
export const settingsPages = ["general", "appearance", "shortcuts"] as const;
export const setupPages = [
  "overview",
  "signin",
  "folders",
  "connection",
  "attachment",
] as const;
export const homeViews = ["overview"] as const;
export const navigationAreas = [
  "home",
  "chatgpt",
  "activity",
  "setup",
  "settings",
] as const;
export const sheets = [
  "connection-tests",
  "deep-test",
  "chat-conversations",
  "search",
  "task",
  "update",
  "update-recovery",
  "activity",
  "unresolved-actions",
  "notifications",
] as const;
export type SettingsPage = (typeof settingsPages)[number];
export type SetupStep = (typeof setupPages)[number];
export type HomeView = (typeof homeViews)[number];
export type NavigationArea = (typeof navigationAreas)[number];
export type Sheet = (typeof sheets)[number];

export function validNavigation(destination: {
  area?: NavigationArea;
  page?: SettingsPage;
  setupStep?: SetupStep;
  homeView?: HomeView;
}): boolean {
  return (
    (destination.area === undefined ||
      navigationAreas.includes(destination.area)) &&
    (destination.page === undefined ||
      settingsPages.includes(destination.page)) &&
    (destination.setupStep === undefined ||
      setupPages.includes(destination.setupStep)) &&
    (destination.homeView === undefined ||
      homeViews.includes(destination.homeView))
  );
}
