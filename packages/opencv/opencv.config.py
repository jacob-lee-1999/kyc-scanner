# Functions exported to JS. Keep in sync with what apps/web/public/detector-core.js calls.

core = {
    '': ['convertScaleAbs', 'countNonZero', 'mean', 'meanStdDev'],
}

imgproc = {
    '': [
        'approxPolyDP', 'arcLength', 'Canny', 'contourArea', 'cvtColor', 'dilate', 'findContours',
        'GaussianBlur', 'getPerspectiveTransform', 'getStructuringElement', 'HoughLinesP', 'isContourConvex',
        'Laplacian', 'Sobel', 'threshold', 'warpPerspective', 'createCLAHE',
    ],
}

# createCLAHE becomes the cv.CLAHE constructor, which needs its Algorithm base bound.
classes = {
    'Algorithm': [],
    'CLAHE': ['apply'],
}

white_list = makeWhiteList([core, imgproc, classes])
