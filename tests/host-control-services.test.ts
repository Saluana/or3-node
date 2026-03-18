import { afterEach, describe, expect, test } from "bun:test";

import { HostServiceManager } from "../src/host-control/services.ts";

describe("HostServiceManager", () => {
  let manager: HostServiceManager;

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- manager may be uninitialized if test throws before assignment
    if (manager) manager.stopAll();
  });

  test("launch starts a service and returns handle", () => {
    manager = new HostServiceManager();
    const service = manager.launch({
      serviceName: "test-svc",
      command: "sleep",
      args: ["60"],
      port: 8080,
    });
    expect(service.serviceId).toMatch(/^svc_/);
    expect(service.serviceName).toBe("test-svc");
    expect(service.port).toBe(8080);
    expect(service.pid).toBeGreaterThan(0);
  });

  test("get retrieves service by id", () => {
    manager = new HostServiceManager();
    const service = manager.launch({
      serviceName: "test-svc",
      command: "sleep",
      args: ["60"],
      port: 3000,
    });
    expect(manager.get(service.serviceId)).not.toBeNull();
    expect(manager.get("nonexistent")).toBeNull();
  });

  test("list returns all running services", () => {
    manager = new HostServiceManager({ maxConcurrentServices: 10 });
    manager.launch({ serviceName: "svc1", command: "sleep", args: ["60"], port: 3001 });
    manager.launch({ serviceName: "svc2", command: "sleep", args: ["60"], port: 3002 });
    expect(manager.list().length).toBe(2);
  });

  test("stop terminates a service by id", () => {
    manager = new HostServiceManager();
    const service = manager.launch({
      serviceName: "stop-test",
      command: "sleep",
      args: ["60"],
      port: 4000,
    });
    const stopped = manager.stop(service.serviceId);
    expect(stopped).toBe(true);
    expect(manager.get(service.serviceId)).toBeNull();
  });

  test("stop returns false for non-existent service", () => {
    manager = new HostServiceManager();
    expect(manager.stop("nonexistent")).toBe(false);
  });

  test("stopAll terminates all services", () => {
    manager = new HostServiceManager({ maxConcurrentServices: 10 });
    manager.launch({ serviceName: "svc1", command: "sleep", args: ["60"], port: 5001 });
    manager.launch({ serviceName: "svc2", command: "sleep", args: ["60"], port: 5002 });
    manager.stopAll();
    expect(manager.list().length).toBe(0);
  });

  test("max concurrent services enforced", () => {
    manager = new HostServiceManager({ maxConcurrentServices: 1 });
    manager.launch({ serviceName: "first", command: "sleep", args: ["60"], port: 6001 });
    expect(() =>
      manager.launch({ serviceName: "second", command: "sleep", args: ["60"], port: 6002 }),
    ).toThrow("too many concurrent services");
  });

  test("onOutput callback receives service stdout", async () => {
    const outputs: string[] = [];
    manager = new HostServiceManager({
      onOutput: (_id, data) => outputs.push(data),
    });
    manager.launch({
      serviceName: "echo-svc",
      command: "echo",
      args: ["hello-service"],
      port: 7000,
    });

    // Wait for output
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (outputs.some((o) => o.includes("hello-service"))) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
    expect(outputs.some((o) => o.includes("hello-service"))).toBe(true);
  });

  test("onExit callback fires when service exits", async () => {
    let exitServiceId = "";
    let exitCode = -999;
    manager = new HostServiceManager({
      onExit: (serviceId, code) => {
        exitServiceId = serviceId;
        exitCode = code;
      },
    });
    const service = manager.launch({
      serviceName: "fast-exit",
      command: "true",
      port: 8000,
    });

    // Wait for exit
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (exitCode !== -999) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
    expect(exitServiceId).toBe(service.serviceId);
    expect(exitCode).toBe(0);
  });

  test("service.stop terminates the process", () => {
    manager = new HostServiceManager();
    const service = manager.launch({
      serviceName: "direct-stop",
      command: "sleep",
      args: ["60"],
      port: 9000,
    });
    service.stop();
    expect(manager.get(service.serviceId)).toBeNull();
  });
});
