import { z } from "zod";
import type { ATSAdapter } from "./baseAdapter.js";
import type { FieldMapPack } from "./fieldMaps.js";

const AdapterManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  supportedDomains: z.array(z.string().min(1)).min(1)
});

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export interface RegisteredAdapter {
  manifest: AdapterManifest;
  adapter: ATSAdapter;
  fieldMapPack: FieldMapPack;
}

export class AdapterRegistry {
  private readonly adapters: RegisteredAdapter[] = [];

  register(input: RegisteredAdapter): void {
    AdapterManifestSchema.parse(input.manifest);
    this.adapters.push(input);
  }

  resolveByUrl(url: string): RegisteredAdapter | undefined {
    return this.adapters.find((entry) => {
      return entry.manifest.supportedDomains.some((domain) => url.toLowerCase().includes(domain));
    });
  }

  list(): RegisteredAdapter[] {
    return [...this.adapters];
  }
}
