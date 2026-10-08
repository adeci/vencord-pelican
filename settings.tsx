import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
  serverUrl: {
    type: OptionType.STRING,
    displayName: "Zipline server URL",
    description: "Your Zipline server's HTTPS address.",
    default: "",
    placeholder: "https://zipline.example.com",
    componentProps: { "aria-label": "Zipline server URL" },
  },
  apiToken: {
    type: OptionType.STRING,
    displayName: "API token",
    description: "Non-admin token. Saved unencrypted in Vencord settings.",
    default: "",
    placeholder: "Paste your Zipline API token",
    componentProps: {
      type: "password",
      "aria-label": "Zipline API token",
      autoComplete: "off",
      spellCheck: false,
    },
  },
});
