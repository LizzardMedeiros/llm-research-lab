/** Invalid scenario/experiment configuration, detected before a run starts. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
