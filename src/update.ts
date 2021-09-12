/* eslint-disable max-depth */
/* eslint-disable complexity */

import slugify from '@sindresorhus/slugify'
import {mkdirp, readFile, writeFile} from 'fs-extra'
import {load} from 'js-yaml'
import {join} from 'path'
import {getConfig} from './helpers/config'
// import {replaceEnvironmentVariables} from './helpers/environment'
import {commit, lastCommit, push} from './helpers/git'
import {infoErrorLogger, statusLogger} from './helpers/log'
import {ping} from './helpers/ping'
import {curl} from './helpers/request'
import {SiteHistory} from './interfaces'
import {generateSummary} from './summary'
import cli from 'cli-ux'
import chalk from 'chalk'
import {closeIncident, closeMaintenanceIncidents, createComment, createIncident, getIncidents} from './helpers/incidents'
import { debug } from 'console'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export const update = async (shouldCommit = false) => {
  // !! DIFF:: not checking if the .yml is valid, missing shouldContinue()
  cli.action.start(`Running ${shouldCommit ? 'response-time' : 'update'} workflow`)
  await mkdirp('history')

  const config = await getConfig()
  let hasDelta = false

  // close maintenance issues
  const incidents = await getIncidents()
  const ongoingMaintenanceEvents = await closeMaintenanceIncidents()
  commit('$PREFIX Maintanence issues closed'.replace('$PREFIX', config.incidentCommitPrefixClose || '📛'),
    (config.commitMessages || {}).commitAuthorName,
    (config.commitMessages || {}).commitAuthorEmail)

  for await (const site of config.sites) {
    infoErrorLogger.info(`Checking ${site.url}`)
    const slug = site.slug || slugify(site.name)
    let currentStatus = 'unknown'
    let startTime = new Date()
    try {
      const siteHistory = load(
        (await readFile(join('.', 'history', `${slug}.yml`), 'utf8'))
        .split('\n')
        .map(line => (line.startsWith('- ') ? line.replace('- ', '') : line))
        .join('\n')
      ) as SiteHistory
      currentStatus = siteHistory.status || 'unknown'
      startTime = new Date(siteHistory.startTime || new Date())
    } catch (error) {}
    infoErrorLogger.info(`Current status ${site.slug} ${currentStatus} ${startTime}`)

    /**
     * Check whether the site is online
     */
    const performTestOnce = async (): Promise<{
      result: {
        httpCode: number;
      };
      responseTime: string;
      status: 'up' | 'down' | 'degraded';
    }> => {
      if (site.check === 'tcp-ping') {
        infoErrorLogger.info('Using tcp-ping instead of curl')
        try {
          let status: 'up' | 'down' | 'degraded' = 'up'
          const tcpResult = await ping({
            // address: replaceEnvironmentVariables(site.url),
            // port: Number(replaceEnvironmentVariables(site.port ? String(site.port) : '')),
            address: site.url,
            attempts: 5,
            port: Number(site.port),
          })
          if (tcpResult.avg > (site.maxResponseTime || 60000)) status = 'degraded'
          infoErrorLogger.info(`Got result ${tcpResult}`)
          return {
            result: {httpCode: 200},
            responseTime: (tcpResult.avg || 0).toFixed(0),
            status,
          }
        } catch (error) {
          infoErrorLogger.info(`Got pinging error ${error}`)
          return {result: {httpCode: 0}, responseTime: (0).toFixed(0), status: 'down'}
        }
      } else {
        const result = await curl(site)
        infoErrorLogger.info(`Result from test ${result.httpCode} ${result.totalTime}`)
        const responseTime = (result.totalTime * 1000).toFixed(0)
        const expectedStatusCodes = (
          site.expectedStatusCodes || [
            200,
            201,
            202,
            203,
            200,
            204,
            205,
            206,
            207,
            208,
            226,
            300,
            301,
            302,
            303,
            304,
            305,
            306,
            307,
            308,
          ]
        ).map(Number)
        let status: 'up' | 'down' | 'degraded' = expectedStatusCodes.includes(
          Number(result.httpCode)
        ) ?
          'up' :
          'down'
        if (parseInt(responseTime, 10) > (site.maxResponseTime || 60000)) status = 'degraded'
        if (status === 'up' && typeof result.data === 'string') {
          if (site.__dangerous__body_down && result.data.includes(site.__dangerous__body_down))
            status = 'down'
          if (
            site.__dangerous__body_degraded &&
            result.data.includes(site.__dangerous__body_degraded)
          )
            status = 'degraded'
        }
        if (
          site.__dangerous__body_degraded_if_text_missing &&
          !result.data.includes(site.__dangerous__body_degraded_if_text_missing)
        )
          status = 'degraded'
        if (
          site.__dangerous__body_down_if_text_missing &&
          !result.data.includes(site.__dangerous__body_down_if_text_missing)
        )
          status = 'down'
        return {result, responseTime, status}
      }
    }

    let {result, responseTime, status} = await performTestOnce()
    /**
     * If the site is down, we perform the test 2 more times to make
     * sure that it's not a false alarm
     */
    if (status === 'down' || status === 'degraded') {
      wait(1000)
      const secondTry = await performTestOnce()
      if (secondTry.status === 'up') {
        result = secondTry.result
        responseTime = secondTry.responseTime
        status = secondTry.status
      } else {
        wait(10000)
        const thirdTry = await performTestOnce()
        if (thirdTry.status === 'up') {
          result = thirdTry.result
          responseTime = thirdTry.responseTime
          status = thirdTry.status
        }
      }
    }

    try {
      if (shouldCommit || currentStatus !== status) {
        await writeFile(
          join('.', 'history', `${slug}.yml`),
          `url: ${site.url}
status: ${status}
code: ${result.httpCode}
responseTime: ${responseTime}
lastUpdated: ${new Date().toISOString()}
startTime: ${startTime}
generator: Upptime <https://github.com/upptime/upptime>
`
        )
        const commitMsg = (
          (config.commitMessages || {}).statusChange ||
          '$PREFIX $SITE_NAME is $STATUS ($RESPONSE_CODE in $RESPONSE_TIME ms) [skip ci] [upptime]'
        )
        .replace(
          '$PREFIX',
          status === 'up' ?
            config.commitPrefixStatusUp || '🟩' :
            status === 'degraded' ?
              config.commitPrefixStatusDegraded || '🟨' :
              config.commitPrefixStatusDown || '🟥'
        )
        .replace('$SITE_NAME', site.name)
        .replace('$SITE_URL', site.url)
        .replace('$SITE_METHOD', site.method || 'GET')
        .replace('$STATUS', status)
        .replace('$RESPONSE_CODE', result.httpCode.toString())
        .replace('$RESPONSE_TIME', responseTime)

        if (status === 'up')
          statusLogger.up(commitMsg)
        else if (status === 'degraded')
          statusLogger.degraded(commitMsg)
        else
          statusLogger.down(commitMsg)

        commit(
          commitMsg,
          (config.commitMessages || {}).commitAuthorName,
          (config.commitMessages || {}).commitAuthorEmail
        )
        if (currentStatus === status) {
          infoErrorLogger.info(`Status is the same ${currentStatus} ${status}`)
        } else {
          infoErrorLogger.info(`Status is different ${currentStatus} to ${status}`)
          hasDelta = true
          debug('Here')
          let issueCommitMessage = ''
          const lastCommitSha = lastCommit()
          const maintenanceIssueExists = ongoingMaintenanceEvents.find(i => i.slug)
          // Don't create an issue if it's expected that the site is down or degraded
          let expected = false
          if (
            (status === 'down' && maintenanceIssueExists) ||
            (status === 'degraded' && maintenanceIssueExists)
          )
            expected = true
          debug('here - 1.5')
          const issueAlreadyExistsIndex = incidents && incidents[slug] ? incidents[slug].incidents.findIndex(i => i.status === 'open' && i.labels?.includes(slug)) : -1
          // If the site was just recorded as down or degraded, open an issue
          debug('here - 2')
          if ((status === 'down' || status === 'degraded') && !expected) {
            if (issueAlreadyExistsIndex === -1) {
              debug('here-3')
              createIncident(site, {
                assignees: [...(config.assignees || []), ...(site.assignees || [])],
                author: 'Upptime Bot',
                labels: ['status', slug],
              }, status === 'down' ?
                `🛑 ${site.name} is down` :
                `⚠️ ${site.name} has degraded performance`
              , `In [\`${lastCommitSha.substr(
                0,
                7
              )}\`], ${site.name} (${
                site.url
              }) ${status === 'down' ? 'was **down**' : 'experienced **degraded performance**'}:
- HTTP code: ${result.httpCode}
- Response time: ${responseTime} ms
`)
              infoErrorLogger.info('Opened and locked a new issue')
              issueCommitMessage = '$PREFIX Open issue for $SITE - $STATUS [upptime]'
              .replace('$PREFIX', config.incidentCommitPrefixOpen || '📌')
              try {
                // TODO: Add notifications func
                // await sendNotification(
                //   status === 'down' ?
                //     `🟥 ${site.name} (${site.url}) is **down**` :
                //     `🟨 ${site.name} (${site.url}) is experiencing **degraded performance**`
                // )
              } catch (error) {
                infoErrorLogger.error(error)
              }
            } else {
              infoErrorLogger.info('An issue is already open for this')
            }
          } else if (issueAlreadyExistsIndex > -1) {
            debug('here-4')
            // If the site just came back up
            const incident = incidents[slug].incidents[issueAlreadyExistsIndex]
            const title = incident.title
            await createComment(
              {
                author: 'Upptime Bot',
                id: incident.id,
                slug,
                title,
              },
              `**Resolved:** ${site.name} ${
                title.includes('degraded') ?
                  'performance has improved' :
                  'is back up'
              } in [\`${lastCommitSha.substr(
                0,
                7
              )}\`].`
            )
            infoErrorLogger.info('Created comment in issue')
            await closeIncident(slug, incident.id)
            infoErrorLogger.info('Closed issue')
            issueCommitMessage = '$PREFIX Close Issue for $SITE - $STATUS'
            .replace('$PREFIX', config.incidentCommitPrefixClose || '📛')
            try {
              // TODO: Add notifications func
              // await sendNotification(
              //   `🟩 ${site.name} (${site.url}) ${
              //     issues.data[0].title.includes('degraded') ?
              //       'performance has improved' :
              //       'is back up'
              //   }.`
              // )
            } catch (error) {
              infoErrorLogger.error(error)
            }
          } else {
            infoErrorLogger.info('Could not find a relevant issue')
          }
          issueCommitMessage === '' ? {} :
            commit(issueCommitMessage.replace('$SITE', site.url).replace('$STATUS', status),
              (config.commitMessages || {}).commitAuthorName,
              (config.commitMessages || {}).commitAuthorEmail)
        }
      } else {
        infoErrorLogger.info(`Skipping commit, status is ${status}`)
      }
    } catch (error) {
      cli.action.stop(chalk.red('error'))
      infoErrorLogger.error(`${error}`)
    }
  }
  if (config.commits?.provider && config.commits?.provider === 'GitHub')
    push()
  cli.action.stop(chalk.green('done'))
  if (hasDelta) generateSummary()
}
