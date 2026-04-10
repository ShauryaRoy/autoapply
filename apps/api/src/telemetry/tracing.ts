import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let started = false;

export async function bootstrapTracing(): Promise<void> {
  if (started) {
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const sdk = new NodeSDK({
    traceExporter: endpoint ? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) : undefined,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  await sdk.start();
  started = true;
}
