# Functions exported to JS. Keep in sync with what apps/web/public/detector-core.js calls.

core = {
    '': ['convertScaleAbs', 'countNonZero', 'mean', 'meanStdDev'],
}

imgproc = {
    '': [
        'approxPolyDP', 'arcLength', 'Canny', 'contourArea', 'cvtColor', 'dilate', 'findContours',
        'GaussianBlur', 'getPerspectiveTransform', 'getStructuringElement', 'isContourConvex',
        'Laplacian', 'Sobel', 'threshold', 'warpPerspective',
    ],
}

white_list = makeWhiteList([core, imgproc])
