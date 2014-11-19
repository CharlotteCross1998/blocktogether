'use strict';
(function() {

var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    https = require('https'),
    _ = require('sequelize').Utils._,
    actions = require('./actions'),
    updateUsers = require('./update-users'),
    setup = require('./setup');

var twitter = setup.twitter,
    logger = setup.logger,
    sequelize = setup.sequelize,
    remoteUpdateBlocks = setup.remoteUpdateBlocks,
    Action = setup.Action,
    BtUser = setup.BtUser;

// An associative array of streams currently running. Indexed by uid.
var streams = {
  'dummy': 1 // Start with a dummy uid to make the findAll query simpler.
};

// Set the maximum number of sockets higher so we can have a reasonable number
// of streams going. Note: Currently we use User Streams. According to the
// Twitter API docs, an app like this would be better suited for Site Streams,
// but (contrary to the docs) they are not accepting new apps for Site Streams.
https.globalAgent.maxSockets = 40000;

/**
 * For some random users with stored credentials, start receiving their Twitter user
 * stream, in order to be able to insta-block any new users (< 7 days old)
 * or unpopular accounts (< 15 followers) who @-reply one of our users.
 * Once their stream is started we will record that so we don't repeatedly try
 * to start the same streams.
 *
 * We pick random users because sometimes the setInterval calls that trigger
 * this function get stacked up. That means that we query for users to add many
 * times in succession and get the same users each time, because they are not
 * yet in the active set. That, in turn, means we try to connect to streaming
 * and fetch at-replies many times for the same user, and get rate limited.
 */
function startStreams() {
  var streamingIds = Object.keys(streams);
  var streamingHost = 'userstream.twitter.com:443';
  var sockets = https.globalAgent.sockets[streamingHost];
  logger.info('Active streams / open sockets:', streamingIds.length - 1,
    '/', sockets ? sockets.length : 0);
  // Find all users who don't already have a running stream. We start streams
  // even for users that don't have one of the auto-block options
  // (block_new_accounts or block_low_followers) because it's useful to get
  // block/unblock information in a timely way. It also gives us early warning
  // if we start running into limits on number of open streams.
  BtUser
    .findAll({
      where: sequelize.and(
        {
          uid: { not: streamingIds },
          deactivatedAt: null
        },
        // Check for any option that monitors stream for autoblock criteria
        sequelize.or(
          {
            block_new_accounts: true
          },
          {
            block_low_followers: true
          }
        )
      ),
      limit: 10,
      // Note: This is inefficient for large tables but for the current ~4k
      // users it's fine.
      order: 'RAND()'
    }).error(function(err) {
      logger.error(err);
    }).success(function(users) {
      users.forEach(startStream);
    });
}

/**
 * For a given user, connect to the Twitter Streaming API, start receiving
 * updates, and record that connection in the streams map. Also retroactively
 * check the REST API for any mentions we might have missed during downtime.
 * @param {BtUser} User to receive streaming events for.
 */
function startStream(user) {
  var accessToken = user.access_token;
  var accessTokenSecret = user.access_token_secret;
  var boundDataCallback = dataCallback.bind(undefined, user);
  var boundEndCallback = endCallback.bind(undefined, user);

  logger.info('Starting stream for user', user);
  var req = twitter.getStream('user', {
    // Get events for all replies, not just people the user follows.
    'replies': 'all',
    // Only get user-related events, not all tweets in timeline.
    'with': 'user'
  }, accessToken, accessTokenSecret, boundDataCallback, boundEndCallback);

  // Sometimes we get an ECONNRESET that is not caught in the OAuth code
  // like it should be. Catch it here as a backup.
  req.on('error', function(err) {
    logger.error('Socket error for', user, err.message);
  });
  // In normal operation, each open stream should receive an empty data item
  // '{}' every 30 seconds for keepalive. Sometimes a connection will die
  // without Node noticing it for instance if the host switches networks.
  // This ensures the HTTPS request is aborted, which in turn calls
  // endCallback, removing the entry from streams and allowing it to be started
  // again.
  req.setTimeout(70000, function() {
    logger.error('Stream timeout for user', user, 'aborting.');
    req.abort();
  });

  streams[user.uid] = req;

  // When restarting the service or experiencing downtime, there's a gap in
  // streaming coverage. Make sure we cover any tweets we may have missed.
  checkPastMentions(user);
};

/**
 * Fetch a user's mentions from the Twitter REST API, in case we missed any
 * streaming events during downtime. All mentions will get processed the same
 * way as if they had been received through the streaming API. Note that the
 * '< 7 days' criterion will be based on the current time.
 * @param {BtUser} user User to fetch mentions for.
 */
function checkPastMentions(user) {
  twitter.getTimeline('mentions', {count: 50},
    user.access_token, user.access_token_secret,
    function(err, mentions) {
      if (err) {
        logger.error('Error', err.statusCode, '/statuses/mentions',
          err.data, 'for', user);
      } else {
        logger.debug('Replaying', mentions.length, 'past mentions for', user);
        // It's common to have a large number of mentions from each user,
        // because of back-and-forth conversations. De-dupe users before
        // checking for block criteria.
        var mentioningUsers = _.indexBy(mentions.map(function(status) {
          return status.user;
        }), 'id_str');
        Object.keys(mentioningUsers).forEach(function(id_str) {
          checkReplyAndBlock(user, mentioningUsers[id_str]);
        });
      }
    });
}

/**
 * Called when a stream ends for any reason. Verify the user's credentials to
 * mark them as deactivated if necessary, and remove them from the active
 * streams map.
 * @param {BtUser} user The user whose stream ended.
 */
function endCallback(user, httpIncomingMessage) {
  var statusCode = httpIncomingMessage.statusCode;
  logger.warn('Ending stream for', user, statusCode);
  if (statusCode === 401 || statusCode === 403) {
    user.verifyCredentials();
  }
  // The streaming API will return 420 Enhance Your Calm
  // (http://httpstatusdogs.com/420-enhance-your-calm) if the user is connected
  // to the streaming API too many times. If we get that, wait fifteen minutes
  // before reconnecting. This is an attempt to fix a bug where, under heavy
  // load, stream.js would lose track of some connections and reconnect too
  // fast, leading to an unproductive high-CPU loop of trying to restart those
  // loops once a second.
  if (statusCode === 420) {
    var stream = streams[user.uid];
    setTimeout(function() {
      // Double-check it's still the same stream before deleting.
      if (stream === streams[user.uid]) {
        delete streams[user.uid];
      } else {
        // This shouldn't happen.
        logger.error('Tried to delete stream but it had already been replaced', user);
      }
    }, 15 * 60 * 1000);
  } else {
    delete streams[user.uid];
  }
}

/**
 * Called each time there is data available on the user stream.
 * Given the arguments passed to getStream, the only events we receive should be
 * at-replies. TODO: Add sanity check to filter non-at-replies, just in case.
 *
 * On receiving an at-reply, check the age of the sender. If it is less than
 * seven days, block them. Exception: Do not block someone our user already follows.
 */
function dataCallback(recipientBtUser, err, data, ret, res) {
  var recipientUid = recipientBtUser.uid;
  if (!data) return;
  if (data.disconnect) {
    logger.warn(recipientBtUser, 'disconnect message:', data.disconnect);
    // Code 6 is for revoked, e.g.:
    // { code: 6, stream_name:
    //   'twestact4&XXXXXXXXXXXXXXXXXXXXXXXXX-userstream685868461329014147',
    //    reason: 'token revoked for userId 596947990' }
    // Codes 13 and 14 are for user deleted and suspended, respectively.
    // TODO: Each of these states (even revocation!) can be undone, and we'd
    // like the app to resume working normally if that happens. So instead of
    // deleting the user when we get one of these codes, store a 'deactivatedAt'
    // timestamp on the user object. Users with a non-null deactivatedAt would
    // get their credentials retried once per day for 30 days, after which they
    // would be deleted. Regular operations like checking blocks or streaming
    // would not be performed while their deactivatedAt was non-null.
    if (data.disconnect.code === 6 ||
        data.disconnect.code === 13 ||
        data.disconnect.code === 14) {
      recipientBtUser.verifyCredentials();
    }
  } else if (data.warning) {
    if (data.warning.code === 'FOLLOWS_OVER_LIMIT') {
      // These happen any time you start a stream for a user with more than 10k
      // follows, so they are normal and we don't care. They mean that you won't
      // see all tweets on the user's timeline, but we don't care about timeline
      // tweets anyhow.
    } else {
      logger.warn('Stream warning for', recipientBtUser, data.warning.code,
        data.warning.message);
    }
  } else if (data.event) {
    logger.debug('User', recipientBtUser, 'event', data.event);
    // If the event target is present, it's a Twitter User object, and we should
    // save it if we don't already have it.
    if (data.target) {
      updateUsers.storeUser(data.target);
    }

    if (data.event === 'unblock' || data.event === 'block') {
      handleBlockEvent(recipientBtUser, data);
    }
  } else if (data.text && !data.retweeted_status && data.user) {
    // If user A tweets "@foo hi" and user B retweets it, that should not count
    // as a mention of @foo for the purposes of blocking. That retweet would
    // show up in the streaming API with text: "@foo hi", as if user B had
    // tweeted it. The way we would tell it was actually a retweet is because
    // it also has the retweeted_status field set.
    checkReplyAndBlock(recipientBtUser, data.user);
  }
}

/**
 * Given a user object from either the streaming API or the REST API,
 * check whether a mention from that user should trigger a block,
 * i.e. whether they are less than 7 days old or have fewer than 15
 * followers, and the receiving user has enabled the appropriate option.
 * If so, enqueue a block.
 *
 * @param {BtUser} recipientBtUser User who might be doing the blocking.
 * @param {Object} mentioningUser A JSON User object as specified by the
 *   Twitter API: https://dev.twitter.com/overview/api/users
 */
var MIN_AGE = 7;
var MIN_FOLLOWERS = 15;
function checkReplyAndBlock(recipientBtUser, mentioningUser) {
  // If present, data.user is the user who sent the at-reply.
  if (mentioningUser && mentioningUser.created_at &&
      mentioningUser.id_str !== recipientBtUser.uid) {
    var ageInDays = (new Date() - Date.parse(mentioningUser.created_at)) /
      86400 / 1000;
    logger.info('User', recipientBtUser, 'got at reply from',
      mentioningUser.screen_name, mentioningUser.id_str, '(age', ageInDays,
      '/ followers', mentioningUser.followers_count, ')');
    if (ageInDays < MIN_AGE || mentioningUser.followers_count < MIN_FOLLOWERS) {
      // The user may have changed settings since we started the stream. Reload to
      // get the latest setting.
      recipientBtUser.reload().success(function(user) {
        if (ageInDays < MIN_AGE && recipientBtUser.block_new_accounts) {
          logger.info('Queuing block', recipientBtUser, '-->',
            mentioningUser.screen_name, mentioningUser.id_str);
          enqueueBlock(recipientBtUser, mentioningUser.id_str, Action.NEW_ACCOUNT);
        } else if (mentioningUser.followers_count < MIN_FOLLOWERS && recipientBtUser.block_low_followers) {
          logger.info('Queuing block', recipientBtUser, '-->',
            mentioningUser.screen_name, mentioningUser.id_str);
          enqueueBlock(recipientBtUser, mentioningUser.id_str, Action.LOW_FOLLOWERS);
        }
      });
    }
  }
}

/**
 * @type {Object.<string,number>} Currently running timers to check blocks. Used
 * by handleBlockEvent.
 */
var updateBlocksTimers = {};

/**
 * Given a block/unblock event from the streaming API, record it in Actions.
 * We will use unblocks so we know not to re-block that user in the future.
 * NOTE: When we perform unblock
 * actions on a user, they get echoed back to us through the Streaming API.
 * Since the Action we performed in already in the DB, we don't want to insert a
 * different record with cause = 'external'. So we check the DB to avoid
 * recording duplicates.
 *
 * @param {BtUser} recipientBtUser User who received a block / unblock event on their
 *   stream.
 * @param {Object} data A JSON unblock event from the Twitter streaming API.
 */
function handleBlockEvent(recipientBtUser, data) {
  // When we perform an unblock action, it gets echoed back from the Stream API
  // very quickly - on the order of milliseconds. In order to make sure
  // actions.js has had a chance to write the 'done' status to the DB, we wait a
  // second before checking for duplicates.
  // Also, if several blocks or unblocks come rapidly, we keep postponing the
  // updateBlocks call by a second each time. This prevents excessive resource
  // use when a user does a 'Block all' and many blocks show up in the streaming
  // API very rapidly.
  var timerId = updateBlocksTimers[recipientBtUser.uid];
  if (timerId) {
    clearTimeout(timerId);
  }
  updateBlocksTimers[recipientBtUser.uid] = setTimeout(function() {
    remoteUpdateBlocks(recipientBtUser);
  }, 2000);
}

/**
 * Put a block on the Actions list for this user and process it.
 * @param {BtUser} sourceUser User who received a mention from a new account
 *   and will block that new account.
 * @param {string} sinkUserId String-form UID of the author of the mention.
 *   Will be blocked.
 * @param {string} cause One of the valid cause types from Action object
 */
function enqueueBlock(sourceUser, sinkUserId, cause) {
  actions.queueActions(
    sourceUser.uid, [sinkUserId], Action.BLOCK, cause);
}

startStreams();
setInterval(startStreams, 1000);
})();
