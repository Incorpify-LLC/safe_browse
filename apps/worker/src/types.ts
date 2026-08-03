export type ParentContext = { id: string; householdId: string; email: string };
export type DeviceContext = { id: string; childId: string; householdId: string };

export type AppBindings = Env;
export type AppVariables = {
  parent: ParentContext;
  device: DeviceContext;
};
