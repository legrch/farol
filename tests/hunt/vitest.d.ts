declare module "vitest" {
  interface TaskMeta {
    hunt?: {
      suiteId: string;
      testId: string;
      mutation?: {
        results: readonly {
          id: string;
          status: "killed" | "survived";
        }[];
        shrinkBudget: number;
      };
    };
  }
}

export {};
