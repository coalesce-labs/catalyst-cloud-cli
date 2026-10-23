---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "claude-only" starting state. Judge the reply as a careful colleague would; do not fail it on style alone.

PASS if ALL of these hold:
1. It says the next step is connecting the workspace's Linear integration, either by offering to start the connection (catalyst onboard) and hand over the consent link it prints, or on the Connections page, and it never asks for a credential.
2. It gives the person one thing to do or answer now (one question, or one page or command with what will be checked afterwards). Mentioning what happens later as context is fine. Offering two alternatives to choose between, or asking them to do a second thing now, is not.
3. It says, at least briefly, why this step matters.
4. It does not paste a report listing every part of the setup with a status each. A one-sentence recap of what is already done is fine.
5. It contains no emoji and no flattery.

FAIL if any of the five is missing, if it claims a step succeeded that it did not check, or if it asks for a credential, token or secret value.
