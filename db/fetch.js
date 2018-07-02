#!/usr/bin/env node
'use strict';

(async () => {

  const fetch = require('fetch-retry');
  const fs = require('fs');
  const githubColors = require('github-colors');
  const githubContribs = require('@ghuser/github-contribs');
  const ora = require('ora');
  const assert = require('assert');

  const dbPath = './db.json';
  const db = require(dbPath);

  await fetchUsers();

  async function fetchUsers() {
    let urlSuffix = '';
    let urlPrefix = 'https://';
    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
      console.log('GitHub API key found.');
      urlSuffix = `?client_id=${process.env.GITHUB_CLIENT_ID}&client_secret=${process.env.GITHUB_CLIENT_SECRET}`;
    }
    if (process.env.GITHUB_USERNAME && process.env.GITHUB_PASSWORD) {
      console.log('GitHub credentials found.');
      urlPrefix = `${urlPrefix}${process.env.GITHUB_USERNAME}:${process.env.GITHUB_PASSWORD}@`;
    }

    const now = new Date;

    for (const userId in db.users) {
      assert(userId.toLowerCase()===userId);
      await fetchUser(userId);
      await fetchUserOrgs(userId);
      await fetchUserContribs(userId);
    }

    for (const repo in db.repos) {
      await fetchRepo(repo);
      await fetchRepoLanguages(repo);
      await fetchRepoSettings(repo);
      await fetchRepoContributors(repo);
    }

    for (const userId in db.users) {
      // must be done after fetchRepo() so that we are able to ignore repos without stars:
      await fetchUserContribsOrgs(userId);

      calculateUserContribsScores(userId);
    }

    writeToDb();
    console.log(`Ran in ${Math.round((new Date - now) / (60 * 1000))} minutes.`);
    console.log(`DB size: ${dbSizeKB()} KB`);

    return;

    async function fetchUser(userId) {
      const userLogin = db.users[userId].login;
      const ghUserUrl = `api.github.com/users/${userLogin}`;
      const githubSpinner = ora(`Fetching ${ghUserUrl}...`).start();
      const ghData = await fetch(`${urlPrefix}${ghUserUrl}${urlSuffix}`);
      const ghDataJson = await ghData.json();
      githubSpinner.succeed(`Fetched ${ghUserUrl}`);

      db.users[userId] = {...db.users[userId], ...ghDataJson};
      db.users[userId].contribs = db.users[userId].contribs || {
        fetched_at: '2000-01-01',
        repos: {}
      };

      // Keep the DB small:
      for (const field of ["id", "node_id", "gravatar_id", "followers_url", "following_url",
                           "gists_url", "starred_url", "subscriptions_url", "events_url",
                           "received_events_url", "site_admin", "hireable", "public_repos",
                           "public_gists", "followers", "following", "private_gists",
                           "total_private_repos","owned_private_repos", "disk_usage",
                           "collaborators", "two_factor_authentication", "plan"]) {
        delete db.users[userId][field];
      }

      writeToDbTemp();
    }

    async function fetchUserOrgs(userId) {
      const orgsUrl = db.users[userId].organizations_url;
      const orgsSpinner = ora(`Fetching ${orgsUrl}...`).start();
      const orgsData = await fetch(`${orgsUrl}${urlSuffix}`);
      const orgsDataJson = await orgsData.json();
      orgsSpinner.succeed(`Fetched ${orgsUrl}`);

      db.users[userId].organizations = [];
      db.orgs = db.orgs || {};
      for (const org of orgsDataJson) {
        db.users[userId].organizations.push(org.login);
        db.orgs[org.login] = {...db.orgs[org.login], ...filterOrgInPlace(org)};
      }
      writeToDbTemp();
    }

    async function fetchUserContribs(userId) {
      // GitHub users might push today a commit authored for example yesterday, so to be on the safe
      // side we always re-fetch at least the contributions of the last few days before the last
      // time we fetched:
      let since = db.users[userId].contribs.fetched_at;
      for (let i = 0; i < 7; ++i) {
        since = githubContribs.dateToString(
          githubContribs.prevDay(githubContribs.stringToDate(since))
        );
      }

      const userLogin = db.users[userId].login;
      const repos = await githubContribs.fetch(userLogin, since, null, ora);
      for (const repo of repos) {
        db.users[userId].contribs.repos[repo] = db.users[userId].contribs.repos[repo] || {
          full_name: repo
        };
      }
      const today = githubContribs.dateToString(now);
      db.users[userId].contribs.fetched_at = today;

      db.repos = db.repos || {};
      for (const repo in db.users[userId].contribs.repos) {
        db.repos[repo] = db.repos[repo] || {};
      }

      writeToDbTemp();
    }

    async function fetchRepo(repo) {
      const ghRepoUrl = `api.github.com/repos/${repo}`;
      const githubSpinner = ora(`Fetching ${ghRepoUrl}...`).start();
      const ghData = await fetch(`${urlPrefix}${ghRepoUrl}${urlSuffix}`);
      const ghDataJson = await ghData.json();
      githubSpinner.succeed(`Fetched ${ghRepoUrl}`);

      ghDataJson.owner = ghDataJson.owner.login;
      db.repos[repo] = {...db.repos[repo], ...ghDataJson};

      // Keep the DB small:
      for (const field of ["node_id", "keys_url", "collaborators_url", "teams_url", "hooks_url",
                           "issue_events_url", "events_url", "assignees_url", "branches_url",
                           "tags_url", "blobs_url", "git_tags_url", "git_refs_url", "trees_url",
                           "statuses_url", "contributors_url", "subscribers_url",
                           "subscription_url", "commits_url", "git_commits_url", "comments_url",
                           "issue_comment_url", "contents_url", "compare_url", "merges_url",
                           "archive_url", "downloads_url", "issues_url", "pulls_url",
                           "milestones_url", "notifications_url", "labels_url", "releases_url",
                           "deployments_url", "ssh_url", "git_url", "clone_url", "svn_url",
                           "has_issues", "has_projects", "has_downloads", "has_wiki",
                           "has_pages", "id", "forks_url", "permissions", "allow_squash_merge",
                           "allow_merge_commit", "allow_rebase_merge"]) {
        delete db.repos[repo][field];
      }

      writeToDbTemp();
    }

    async function fetchRepoLanguages(repo) {
      const ghUrl = `api.github.com/repos/${repo}/languages`;
      const githubSpinner = ora(`Fetching ${ghUrl}...`).start();
      const ghData = await fetch(`${urlPrefix}${ghUrl}${urlSuffix}`);
      const ghDataJson = await ghData.json();
      githubSpinner.succeed(`Fetched ${ghUrl}`);

      for (let language in ghDataJson) {
        ghDataJson[language] = {
          bytes: ghDataJson[language],
          color: githubColors.get(language, true).color
        };
      }

      db.repos[repo].languages = ghDataJson;
      writeToDbTemp();
    }

    async function fetchRepoSettings(repo) {
      const url = `https://rawgit.com/${repo}/master/.ghuser.io.json`;
      const spinner = ora(`Fetching ${repo}'s settings...`).start();
      const data = await fetch(`${url}`);
      if (data.status == 404) {
        spinner.succeed(`No settings found for ${repo}`);
        return;
      }
      const dataJson = await data.json();
      spinner.succeed(`Fetched ${repo}'s settings`);

      db.repos[repo].settings = dataJson;
      writeToDbTemp();
    }

    async function fetchRepoContributors(repo) {
      db.repos[repo].contributors = db.repos[repo].contributors || {};
      const githubSpinner = ora(`Fetching ${repo}'s contributions...`).start();

      // This endpoint only gives us the 100 greatest contributors, so if it looks like there
      // can be more, we use the next endpoint to get the 500 greatest ones:
      if (Object.keys(db.repos[repo].contributors).length < 100) {
        const ghUrl = `api.github.com/repos/${repo}/stats/contributors`;

        let ghDataJson;
        for (let i = 3; i >= 0; --i) {
          const ghData = await fetch(`${urlPrefix}${ghUrl}${urlSuffix}`);
          ghDataJson = await ghData.json();

          if (!Object.keys(ghDataJson).length) {
            // GitHub is still calculating the stats and we need to wait a bit and try again, see
            // https://developer.github.com/v3/repos/statistics/

            if (!i) { // enough retries
              const error = `Failed to fetch ${ghUrl}`;
              githubSpinner.fail(error);
              throw error;
            }

            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }

        for (const contributor of ghDataJson) {
          db.repos[repo].contributors[contributor.author.login] = contributor.total;
        }
      }

      if (Object.keys(db.repos[repo].contributors).length >= 100) {
        // This endpoint won't accept to return more than 30 items per page, see
        // https://developer.github.com/v3/#pagination
        const perPage = 30;
        for (let page = 1; page <= 17; ++page) {
          const ghUrl = `api.github.com/repos/${repo}/contributors?page=${page}&per_page=${perPage}`;
          const ghData = await fetch(`${urlPrefix}${ghUrl}${urlSuffix}`);
          const ghDataJson = await ghData.json();
          try {
            for (const contributor of ghDataJson) {
              db.repos[repo].contributors[contributor.login] = contributor.contributions;
            }
          } catch (e) {
            githubSpinner.fail(`Failed to fetch ${repo}'s contributions`);
            console.error(ghDataJson);
            throw e;
          }

          if (ghDataJson.length < perPage) {
            break;
          }
        }
      }

      if (Object.keys(db.repos[repo].contributors).length >= 500) {
        // We could use https://developer.github.com/v3/repos/commits/#list-commits-on-a-repository
        // in order to fetch more than 500 contributors.
        githubSpinner.fail(`Failed to fetch ${repo}'s contributions`);
        throw 'Not implemented yet';
      }

      githubSpinner.succeed(`Fetched ${repo}'s contributions`);

      writeToDbTemp();
    }

    async function fetchUserContribsOrgs(userId) {
      const orgsSpinner = ora(
        `For each contribution of ${userId}, checking if the repo belongs to an org...`).start();

      // Get rid of all contribs to repos without stars:
      const contribsToRemove = [];
      for (const repo in db.users[userId].contribs.repos) {
        if (!db.repos[repo].stargazers_count) {
          contribsToRemove.push(repo);
        }
      }
      for (const repo of contribsToRemove) {
        delete db.users[userId].contribs.repos[repo];
      }

      const usersAndOrgs = new Set([]);
      for (const repo in db.users[userId].contribs.repos) {
        const userOrOrg = repo.split('/')[0];
        usersAndOrgs.add(userOrOrg);
      }

      db.users[userId].contribs.organizations = [];
      for (const userOrOrg of usersAndOrgs) {
        let isOrg = false;
        if (!(userOrOrg in db.users)) { // otherwise it's a user that we know already
          if (userOrOrg in db.orgs) {
            isOrg = true; // it's an org that we know already
          } else {
            // it might be an org that we don't know yet
            const orgsData = await fetch(`${urlPrefix}api.github.com/orgs/${userOrOrg}${urlSuffix}`);
            const orgsDataJson = await orgsData.json();
            if (orgsDataJson.login) {
              // it's an org that we didn't know yet
              isOrg = true;
              db.orgs[orgsDataJson.login] = filterOrgInPlace(orgsDataJson);
            }
          }
        }

        if (isOrg) {
          db.users[userId].contribs.organizations.push(userOrOrg);
        }
      }

      orgsSpinner.succeed(`Checked all contribution' orgs of ${userId}`);

      writeToDbTemp();
    }

    function filterOrgInPlace(org) { // to keep the DB small
      delete org.id;
      delete org.node_id;
      delete org.events_url;
      delete org.hooks_url;
      delete org.issues_url;
      return org;
    }

    function calculateUserContribsScores(userId) {
      const userLogin = db.users[userId].login;

      const spinner = ora(`Calculating scores for ${userLogin}...`).start();

      for (const repo in db.users[userId].contribs.repos) {
        const score = db.users[userId].contribs.repos[repo];
        score.popularity = logarithmicScoreAscending(1, 10000, db.repos[repo].stargazers_count);

        let totalContribs = 0;
        for (const contributor in db.repos[repo].contributors) {
          totalContribs += db.repos[repo].contributors[contributor];
        }

        score.percentage = db.repos[repo].contributors[userLogin] &&
                           100 * db.repos[repo].contributors[userLogin] / totalContribs || 0;
        score.maturity = logarithmicScoreAscending(40, 10000, totalContribs);
        score.total_commits_count = totalContribs;

        const daysOfInactivity =
                (now - Date.parse(db.repos[repo].pushed_at)) / (24 * 60 * 60 * 1000);
        score.activity = logarithmicScoreDescending(3650, 30, daysOfInactivity);

        // When tweaking the total score, validate that:
        // * for brillout:
        //   * devarchy/website is higher than facebook/react
        //   * brillout/awesome-frontend-libraries is higher than facebook/react
        //   * brillout/frontend-catalogs is higher than facebook/react
        //   * brillout/reprop is higher than facebook/react

        score.total_score =
          (3 + score.percentage * 13 / 100) * score.popularity + 2 * score.maturity + score.activity;
        score.total_score_human_formula = "(3 + percentage * 13) * popularity + 2 * maturity + activity";
        score.max_total_score = 95;
      }

      spinner.succeed(`Calculated scores for ${userLogin}`);
      writeToDbTemp();

      function logarithmicScoreAscending(valFor0, valFor5, val) {
        // For example with valFor0=1, valFor5=100000, val being the number of stars on a
        // project and the result being the project popularity:
        //      1 star  => popularity=0
        //     10 stars => popularity=1
        //    100 stars => popularity=2
        //   1000 stars => popularity=3
        //  10000 stars => popularity=4
        // 100000 stars => popularity=5

        let logInput = (val - valFor0) * 99999 / (valFor5 - valFor0) + 1;
        logInput = Math.max(1, logInput);
        logInput = Math.min(100000, logInput);
        return Math.log10(logInput);
      }

      function logarithmicScoreDescending(valFor0, valFor5, val) {
        return 5 - logarithmicScoreAscending(valFor5, valFor0, val);
      }
    }
  }

  function writeToDbTemp() {
    fs.writeFileSync(`${dbPath}.temp`, JSON.stringify(db, null, 2) + '\n', 'utf-8');
  };

  function writeToDb() {
    fs.renameSync(`${dbPath}.temp`, dbPath);
  };

  function dbSizeKB() {
    return Math.round(fs.statSync(dbPath).size / 1024);
  };

})();
