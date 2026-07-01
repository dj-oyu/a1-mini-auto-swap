import Aedes from "aedes";
import { createServer, type Server as TlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { VirtualPrinter } from "./virtual-printer.ts";
import type { ProjectFileCommand, StatusReport } from "./types.ts";
import {
  type InboundCommand,
  reportTopic,
  requestTopic,
} from "./topics.ts";
import { ensureCerts } from "./tls.ts";

export interface MqttServerOptions {
  port: number; // 8883 in production; 0 lets the OS pick (tests)
  certDir: string;
}

/**
 * In-process MQTT broker (TLS) fronting a VirtualPrinter. No external broker,
 * no Docker — `tls.createServer` + aedes run inside the same Bun process as
 * the stub. The real orchestrator's MQTT client connects here exactly as it
 * would to an A1 mini on :8883 (spec 2/9), so the protocol path is exercised.
 */
export class StubMqttServer {
  private readonly broker = new Aedes();
  private readonly tls: TlsServer;
  private readonly printer: VirtualPrinter;
  private readonly onReport: (r: StatusReport) => void;

  constructor(printer: VirtualPrinter, opts: MqttServerOptions) {
    this.printer = printer;
    const { key, cert } = ensureCerts(opts.certDir);
    this.tls = createServer({ key, cert }, (socket) =>
      this.broker.handle(socket as never),
    );

    // Printer state changes -> publish a report to subscribers.
    this.onReport = (report: StatusReport) => this.publishReport(JSON.stringify(report));
    this.printer.on("report", this.onReport);

    // Inbound commands from clients on the request topic.
    this.broker.on("publish", (packet, client) => {
      if (client === null) return; // broker-originated (our own reports)
      if (packet.topic !== requestTopic(printer.serial)) return;
      this.handleCommand(packet.payload);
    });
  }

  private handleCommand(payload: Buffer | string): void {
    let cmd: InboundCommand;
    try {
      cmd = JSON.parse(payload.toString());
    } catch {
      return; // malformed — a real printer would ignore it too
    }

    if (cmd.pushing?.command === "pushall") {
      this.printer.pushAll();
      return;
    }

    const p = cmd.print;
    if (!p || typeof p.command !== "string") return;
    const seq = typeof p.sequence_id === "string" ? p.sequence_id : "0";

    switch (p.command) {
      case "project_file": {
        const err = this.printer.receiveProjectFile(p as unknown as ProjectFileCommand);
        this.publishAck("project_file", seq, err);
        break;
      }
      case "stop":
        this.printer.stop();
        this.publishAck("stop", seq, null);
        break;
      // pause/resume/gcode_line: modeled in later phases as needed.
      default:
        break;
    }
  }

  /** Publish a command result on the report topic (bambuddy mqtt_server). */
  private publishAck(command: string, sequence_id: string, err: string | null): void {
    this.publishReport(
      JSON.stringify({
        print: {
          command,
          result: err ? "FAILED" : "SUCCESS",
          ...(err ? { reason: err } : {}),
          sequence_id,
          msg: 0,
        },
      }),
    );
  }

  private publishReport(payload: string): void {
    this.broker.publish(
      {
        cmd: "publish",
        topic: reportTopic(this.printer.serial),
        payload: Buffer.from(payload),
        qos: 0,
        dup: false,
        retain: false,
      },
      () => {},
    );
  }

  /** Start listening. Resolves with the bound port (useful when port==0). */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.tls.once("error", reject);
      this.tls.listen(port, () => {
        const addr = this.tls.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  async close(): Promise<void> {
    this.printer.off("report", this.onReport);
    await new Promise<void>((resolve) => this.tls.close(() => resolve()));
    await new Promise<void>((resolve) => this.broker.close(() => resolve()));
  }
}
