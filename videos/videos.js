'use strict';

// The videos show after arriving from the app's Demo videos button or signing in with Google.
// GitHub Pages can't restrict files, so this keeps ordinary visitors out rather than locking the videos.
const CLIENT_ID = '922000608082-id99bt36apvi1fond3n02uialhdlvcg0.apps.googleusercontent.com';
const VIDEOS = ['tour.mp4', 'labels.mp4'];
const $ = (id) => document.getElementById(id);

function cameFromApp() {
  try {
    const from = new URL(document.referrer);
    return from.origin === location.origin && !from.pathname.startsWith('/videos');
  } catch { return false; }
}

function allowedThisTab() {
  try { return sessionStorage.getItem('videos-ok') === '1'; } catch { return false; }
}

function showVideos() {
  try { sessionStorage.setItem('videos-ok', '1'); } catch {}
  $('gate').hidden = true;
  $('films').replaceChildren(...VIDEOS.map((file) => {
    const video = document.createElement('video');
    video.src = file;
    video.controls = true;
    video.preload = 'metadata';
    return video;
  }));
  $('films').hidden = false;
}

function signIn() {
  const note = $('gate-note');
  if (!window.google?.accounts?.oauth2) { note.textContent = 'Google sign-in has not loaded yet. Try again in a moment.'; return; }
  note.textContent = '';
  google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: 'email',
    include_granted_scopes: false,
    callback: (reply) => {
      if (reply.access_token) showVideos();
      else note.textContent = 'Google did not sign you in. Please try again.';
    },
    error_callback: () => { note.textContent = 'Google did not sign you in. Please try again.'; },
  }).requestAccessToken();
}

if (cameFromApp() || allowedThisTab()) showVideos();
else {
  $('gate').hidden = false;
  $('sign-in').addEventListener('click', signIn);
}
