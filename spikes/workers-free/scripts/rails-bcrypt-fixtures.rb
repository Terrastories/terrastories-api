# Emits bcrypt hashes exactly as Rails has_secure_password stores them (bcrypt-ruby 3.1.20,
# the version pinned in Terrastories rails/Gemfile.lock). Throwaway test passwords only.
# Run: docker run --rm -v "$PWD:/w" -w /w ruby:3.3-slim sh -c 'apt-get update -qq &&
#   apt-get install -y -qq build-essential && gem install bcrypt -v 3.1.20 &&
#   ruby scripts/rails-bcrypt-fixtures.rb' > results/rails-bcrypt-fixtures.json
require 'bcrypt'
require 'json'
passwords = [
  'correct horse battery staple',
  'pässwörd-ünïcode-日本語',
  'a' * 72,
  'a' * 72 + 'IGNORED-after-72-bytes',
  'é' * 40, # 80 bytes in UTF-8: truncation splits a code point
  ' leading and trailing spaces ',
]
out = []
[10, 12].each do |cost|
  passwords.each do |pw|
    out << { cost: cost, password: pw, hash: BCrypt::Password.create(pw, cost: cost).to_s }
  end
end
puts JSON.pretty_generate({ bcryptRuby: Gem.loaded_specs['bcrypt'].version.to_s, ruby: RUBY_VERSION, fixtures: out })
