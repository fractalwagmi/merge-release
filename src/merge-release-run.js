#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const bent = require('bent')
const git = require('simple-git')()
const { execSync, spawnSync, spawn } = require('child_process')
const { promisify } = require('util')
const { existsSync } = require('fs');
const { EOL } = require('os');

const exec = (str, cwd) => {
  const [cmd, ...args] = str.split(' ')
  const ret = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (ret.status) {
    console.error(ret)
    console.error(`Error: ${str} returned non-zero exit code`)
    process.exit(ret.status)
  }
  return ret
}

const getlog = promisify(git.log.bind(git))

const get = bent('json', process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org/')

const event = JSON.parse(fs.readFileSync('/github/workflow/event.json').toString())

const deployDir = path.join(process.cwd(), process.env.DEPLOY_DIR || './')
const srcPackageDir = path.join(process.cwd(), process.env.SRC_PACKAGE_DIR || './')

console.log('            using deploy directory : ' + deployDir)
console.log('using src directory (package.json) : ' + srcPackageDir)

let pkg = require(path.join(deployDir, 'package.json'))

const run = async () => {
  if (!process.env.NPM_AUTH_TOKEN) throw new Error('Merge-release requires NPM_AUTH_TOKEN')
  let latest
  try {
    latest = await get(pkg.name + '/latest')
  } catch (e) {
    // unpublished
  }

  let messages

  if (latest) {
    if (latest.gitHead === process.env.GITHUB_SHA) return console.log('SHA matches latest release, skipping.')
    if (latest.gitHead) {
      try {
        let logs = await getlog({ from: latest.gitHead, to: process.env.GITHUB_SHA })
        messages = logs.all.map(r => r.message + '\n' + r.body)
      } catch (e) {
        latest = null
      }
    } else {
      latest = null
    }
  }
  if (!latest) {
    messages = (event.commits || []).map(commit => commit.message + '\n' + commit.body)
  }

  let version = 'patch'
  if (messages.map(message => message.includes('BREAKING CHANGE') || message.includes('!:')).includes(true)) {
    version = 'major'
  } else if (messages.map(message => message.toLowerCase().startsWith('feat')).includes(true)) {
    version = 'minor'
  }

  const setVersion = version => {
    const json = execSync(`jq '.version="${version}"' package.json`, { cwd: srcPackageDir })
    fs.writeFileSync(path.join(srcPackageDir, 'package.json'), json)

    if (deployDir !== './') {
      const deployJson = execSync(`jq '.version="${version}"' package.json`, { cwd: deployDir })
      fs.writeFileSync(path.join(deployDir, 'package.json'), deployJson)
    }
  }

  let currentVersion = execSync(`npm view ${pkg.name} version`, { cwd: srcPackageDir }).toString()
  setVersion(currentVersion)
  console.log('current:', currentVersion, '/', 'version:', version)
  let newVersion = execSync(`npm version --git-tag-version=false ${version}`, { cwd: srcPackageDir }).toString()
  newVersion = newVersion.replace(/(\r\n|\n|\r)/gm, '')
  setVersion(newVersion.slice(1))
  console.log('new version:', newVersion)
  
  await runInWorkspace('git', ['commit', '-a', '-m', 't']);
  const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
  await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
  await runInWorkspace('git', ['push', remoteRepo, '--tags']);
  await runInWorkspace('git', ['push', remoteRepo]);
  
  if (pkg.scripts && pkg.scripts.publish) {
    exec(`npm run publish`, deployDir)
  } else {
    exec(`npm publish`, deployDir)
  }
  
  
  
//   exec(`git checkout package.json`) // cleanup
//   exec(`git tag ${newVersion}`)
//   exec(`echo "::set-output name=version::${newVersion}"`) // set action event.{STEP_ID}.output.version

  /*
  const env = process.env
  const remote = `https://${env.GITHUB_ACTOR}:${env.GITHUB_TOKEN}@github.com/${env.GITHUB_REPOSITORY}.git`
  exec(`git push ${remote} --tags`)
  */
}
run()


function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: srcPackageDir });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
}
