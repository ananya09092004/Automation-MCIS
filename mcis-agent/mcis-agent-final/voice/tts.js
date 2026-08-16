const say = require('say');

function speak(text) {
  return new Promise((resolve, reject) => {
    say.speak(text, null, 1.0, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

module.exports = { speak };
