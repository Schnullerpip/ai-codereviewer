import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Configuration, OpenAIApi } from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const configuration = new Configuration({
  apiKey: OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

const systemPrompt = `You are an expert software engineer specialized in doing code reviews. Complete every element of the array.
Your task is to code review pull requests. You concentrate on reviewing semantic errors, bugs, performance issues, security risks,
 best practices and code style. You are not responsible for testing the code or commenting on
possible errors that a typesystem or a build process would detect anyway. 
 Instructions:
- Provide the response in following JSON format:  {"lineNumber":  <line_number>, "reviewComment": "<review comment>", "importance":<importance_ranking>};;;
- The importance_ranking is a number between 1 and 20, where 20 means major issue (e.g. security risk) and 1 means optional change (e.g. a variable name has been changed is everything still working?).
- Focus on logic errors, bugs, performance and control flow readability only.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Start the comment with a category name that best fits the idea of the comment, e.g.: "Security Risk: <rest of comment>".
- Use the given description only for the overall context and only comment the code.
- don't comment on versions e.g. libraries, dependencies because your training data is limited and probably outdated.
- don't just assume that something has been forgotten.
- IMPORTANT: Do not give positive comments or compliments.
- IMPORTANT: NEVER suggest to make sure that some change won't break something.
- IMPORTANT: NEVER suggest adding comments to the code.

E.G.:

Pull request title: feat/improve performance
Pull request description: 

---
This PR improves the performance of the application by using a more efficient algorithm.
---

Git diff to review:

\`\`\`diff
@@ -17,13 +17,16 @@
17 -invokeInefficientAlgorithm()
17 invokeEfficientAlgorithm()
18 console.log('test log')
\`\`\`
{"lineNumber": 18, "reviewComment": "remove this console.log, as it appears to be a debug log", "importance": 2};;;
`

const queryConfig = {
  model: OPENAI_API_MODEL,
  temperature: 0.2,
  top_p: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
};

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<
  Array<{ body: string; path: string; line: number; importance: number }>
> {
  const comments: Array<{
    body: string;
    path: string;
    line: number;
    importance: number;
  }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    console.log('[AICODEREVIEWER::ANALYZING]::', file.to);

    const prompts: Array<string> = [];

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      prompts.push(prompt);
    }

    const aiResponse = await getAIResponse(prompts);
    if (aiResponse.length === 0) {
      console.log('AICODEREVIEWER::No AI response for file', file.to);
      continue
    }

    const newComments = createComments(file, aiResponse);
    if (newComments) {
      comments.push(...newComments);
    }
  }

  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return ` Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

/**
 * Try joining the prompts together for batching
 * see https://community.openai.com/t/batching-with-chatcompletion-endpoint/137723
 */
async function getAIResponse(prompts: Array<string>): Promise<
  Array<{
    lineNumber: string;
    reviewComment: string;
    importance: number;
  }>
> {
  const joinedPrompts = prompts.join(";\n\n");
  console.log('[AICODEREVIEWER::PROMPTS]::', prompts);
  console.log('[AICODEREVIEWER::JOINEDPROMPTS]::----\n\n', joinedPrompts, '\n\n----');

  const response = await openai.createChatCompletion({
    ...queryConfig,
    messages: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: joinedPrompts,
      },
    ],
  });

  console.log('[AICODEREVIEWER::OPENAI::RESPONSE]::"', response.data.choices[0].message?.content, '"');

  const res = response.data.choices[0].message?.content?.trim().split(";;;");

  if (!res) {
    console.log("[AICODEREVIEWER::]::Response not interpretable. ", res);
    return [];
  }

  if(res[res.length -1] === ';;;') {
    const removed = res.pop();
    console.log('[AICODEREVIEWER::REMOVED]::"', removed, '"');
  }

  console.log('[AICODEREVIEWER::INTERPRETED]::"', res);

  try {
    return res.map((r) => JSON.parse(r));
  } catch (e) {
    return []
  }
}

function createComments(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
    importance: number;
  }>
): Array<{ body: string; path: string; line: number; importance: number }> {
  return aiResponses
    .flatMap((aiResponse) => {
      if (!file.to) {
        return undefined;
      }

      const line = Number(aiResponse.lineNumber)
      if (Number.isNaN(line)) {
        console.warn(
          '[AICODEREVIEWER]::CERATECOMMENTS::',
          aiResponse.lineNumber,
          'is not a number'
        )
        return undefined
      }

      return {
        body: '[AI_REVIEWER]::' + aiResponse.reviewComment,
        path: file.to,
        line,
        importance: aiResponse.importance ?? 1,
      }
    })
    .filter((c) => c !== undefined) as Array<{
    body: string;
    path: string;
    line: number;
    importance: number;
  }>
}

async function createReview(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length <= 0) {
    return;
  }

  const commentsSortedByImportanceDesc = comments.sort(
    (a, b) => b.importance - a.importance
  );
  const commentsCapped = commentsSortedByImportanceDesc.slice(0, 15);
  const commentsForOctokit = commentsCapped.map((c) => ({
    body: c.body,
    path: c.path,
    line: c.line,
    //no importance
  }))

  await createReview(
    prDetails.owner,
    prDetails.repo,
    prDetails.pull_number,
    commentsForOctokit
  );
}

main().catch((error) => {
  console.error("Error:", error);
});
